/**
 * 61_api_v1_weekly_ai_plan.gs — WEEKLY AI PLAN live backend generation owner (F1-7N-D-2b).
 * ---------------------------------------------------------------------------------------------------------------
 * The ONE live Apps Script owner behind the `weeklyAiPlan.generate` action + the future Monday scheduler (D-4).
 * It is a THIN I/O shell: it HARVESTS canonical facts from existing owners, hands them to the PURE, Node-verified
 * core (KMWHA harvest-map → KMWRB (company,country) batch → per-marketplace K3 persistence via the frozen
 * orchestrator + C1 semantics), and returns a bounded envelope. It re-derives NO business value.
 *
 * USER-frozen authority (F1-7N-D-2b-PRE): generation universe = (company,country) BATCH; §7 demandWeight basis =
 * FORECAST_DRIVEN forecastShareQty, normalized ONCE across the whole universe by a SINGLE KMAF.projectAllocationFacts
 * call; persistence stays marketplace-grain K3 (allocation universe != persistence identity). A manual invocation
 * from any marketplace page triggers the COMPLETE (company,country) batch — `currentMarketplace` is readback context
 * only and MUST NOT narrow the allocation universe. Count-once: each shared pool is allocated exactly once across all
 * marketplace drafts (enforced by KMWRB running one allocation per SKU then fanning out).
 *
 * Reused owners (NO second engine): gapCalcResolveContext_ (cycle) · handleRecommendationWorkspaceGet_ (per-market
 * horizons + site identity) · KMPCX.resolveForecastWeight (§7 forecastShareQty) · KMAF.projectAllocationFacts (ONE
 * multi-site §7 call) · gapOpReadSupplyPoolFacts_ (pools) · recGenUpcBySku_ (UPC) · gapReadObjects_ (warehouses) ·
 * KMPR/KMPL (repository + LockService) mirrored from 24_. Persists ONLY shipping_allocation_drafts / _lines. Creates
 * NO Request Order / PO / shipment; reserves NO stock; emits NO carrier/rate/lead-time/ETA/cost.
 *
 * LIVE-VERIFY: the harvest (weeklyAiPlanHarvest_ / weeklyAiPlanBuildKmafReceivers_) is Apps-Script-runtime only and is
 * NOT covered by the Node suites (which verify KMWHA/KMWRB/KMAF-§7). It is the primary target of the D-2b live smoke.
 */

// Frozen factory identity (F1-7N-D-2b-PRE / §35A.7): exact warehouse_id only — never country/company/name/token.
var WEEKLY_AI_PLAN_FACTORY_IDENTITY_ = { CN_YOUXIN: 'WH-TW-CN-FACTORY-YOUXIN', TW_SHENGYI: 'WH-TW-TW-FACTORY-RES' };
var WEEKLY_AI_PLAN_SOURCE_PAGE_ = 'inventory_replenishment';

function weeklyAiPlanStr_(v) { return String(v === undefined || v === null ? '' : v).trim(); }
// R5: a numeric coercion beside the string one. Non-numeric reads as 0 rather than NaN, so a missing
// quantity can never poison a total by arithmetic.
function weeklyAiPlanNum_(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function weeklyAiPlanErr_(code, message, extra) { var e = { code: code, message: message || code }; if (extra) for (var k in extra) e[k] = extra[k]; return e; }

// ================================================================================================================
// F1-7N-FA-3C-DRAFT-MODEL-R6F2F1 — INTERNAL controlled-execution authority. A capability object is MINTED only by the
// internal R6F2F executor (server-side TEMP tooling) and is passed to weeklyAiPlanGenerateK2_ as a dedicated positional
// argument — NEVER through request/body fields (actor/mode/businessScope/checksum/token). It authorizes ONE generation
// while the GLOBAL flag is false, bound to an EXACT (company|country|marketplace|planning_cycle) scope key.
//
// Why a public/frontend request can NEVER manufacture it:
//   (1) The capability is a 6th positional argument. The public router → handleGenerateWeeklyAiPlanDraft_ call site
//       passes only 5 args (…, body); a client cannot inject a 6th argument, and any capability-shaped object placed in
//       `body` arrives as the 5th arg, never as `controlledAuth`.
//   (2) verify() only accepts a nonce present in the closure-private `minted` set, which is populated ONLY by mint().
//       A public API request runs in its own execution that never calls mint() → the set is empty → every hand-built
//       capability fails CAPABILITY_NOT_MINTED_IN_EXECUTION. The nonce is unguessable (Utilities.getUuid) and one-shot.
//   (3) The scope key is re-derived from the ACTUAL request inside the gate and must equal the minted scope key, so a
//       capability can never authorize a different / widened scope.
var WeeklyAiPlanControlledAuthority_ = (function () {
  var minted = {};   // nonce -> scopeKey, private to this IIFE and to the current execution only
  function scopeKey(spec) { var s = (spec && spec.scope) || {}; return [String(s.company || ''), String(s.country || ''), String(s.marketplace || ''), String((spec && spec.planning_cycle) || '')].join('|'); }
  return {
    scopeKey: scopeKey,
    mint: function (spec) { var nonce = Utilities.getUuid(); minted[nonce] = scopeKey(spec); return { __wap_controlled: true, nonce: nonce, spec: spec }; },
    verify: function (cap, liveScopeSpec) {
      if (!cap || cap.__wap_controlled !== true || !cap.nonce) return { ok: false, reason: 'NO_INTERNAL_CAPABILITY' };
      var stored = minted[cap.nonce];
      if (stored === undefined) return { ok: false, reason: 'CAPABILITY_NOT_MINTED_IN_EXECUTION' };
      if (stored !== scopeKey(cap.spec)) return { ok: false, reason: 'CAPABILITY_TAMPERED' };
      var live = scopeKey(liveScopeSpec);
      if (scopeKey(cap.spec) !== live) return { ok: false, reason: 'CAPABILITY_SCOPE_MISMATCH' };
      if (!((liveScopeSpec.scope || {}).marketplace)) return { ok: false, reason: 'CONTROLLED_REQUIRES_EXACT_MARKETPLACE' };
      delete minted[cap.nonce];   // ONE-SHOT — a capability authorizes exactly one generation
      return { ok: true, reason: null };
    }
  };
})();

/**
 * Router handler for `weeklyAiPlan.generate`.
 * body = { action, company, country, planningCycle?, mode?, confirmRegenerateOverUserEdits?,
 *          currentMarketplace?/requestedMarketplace? (readback-only), actor? }
 * Returns jsonResponse_({ success, data, errors }).
 */
function handleGenerateWeeklyAiPlanDraft_(body) {
  try {
    body = body || {};
    var company = weeklyAiPlanStr_(body.company);
    var country = weeklyAiPlanStr_(body.country);
    var mode = weeklyAiPlanStr_(body.mode) || 'MANUAL_REGENERATE';
    if (mode !== 'MANUAL_REGENERATE' && mode !== 'SCHEDULED_REFRESH') return jsonResponse_({ success: false, errors: [weeklyAiPlanErr_('INVALID_MODE', 'mode must be MANUAL_REGENERATE|SCHEDULED_REFRESH')] });
    if (!company || !country) return jsonResponse_({ success: false, errors: [weeklyAiPlanErr_('INVALID_SCOPE', 'company + country required (generation universe is company,country)')] });

    if (typeof KMWHA === 'undefined' || typeof KMWRB === 'undefined' || typeof KMAF === 'undefined' || typeof KMWRR === 'undefined') {
      return jsonResponse_({ success: false, errors: [weeklyAiPlanErr_('WEEKLY_AI_PLAN_NOT_BUNDLED', 'weekly AI plan core not present in bundle (KMWHA/KMWRB/KMAF/KMWRR)')] });
    }

    // F1-7N-FA-3C-R6F2 — generation is STAGED OFF. When INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ is false, run NOTHING
    // (neither the legacy K3 batch NOR the K2 path) — this is the canonical staged-off posture (the frontend also gates
    // the button). When true, generation uses the K2 route-group path (route derivation → K2 partition → atomic write),
    // NEVER the legacy K3 per-marketplace persistence. So generation and manual save share the SAME K2 identity.
    var genEnabled = (typeof inventoryAiPlanDbGenerationEnabled_ === 'function') && inventoryAiPlanDbGenerationEnabled_() === true;
    if (!genEnabled) {
      return jsonResponse_({ success: false, disabled: true, errors: [weeklyAiPlanErr_('INVENTORY_AI_PLAN_DB_GENERATION_DISABLED', 'Inventory AI Plan DB generation is staged OFF (INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false); zero rows written. Run TEMP_R6F2_PREFLIGHT_INVENTORY_K2_ROUTE_AUTHORITY() before any controlled enablement.')] });
    }

    var ss = SpreadsheetApp.openById(prodExpectedDbId_());
    if (typeof prodAssertDbTarget_ === 'function') prodAssertDbTarget_(ss, prodExpectedDbId_()); // S0-5 exact-ID gate

    var planningCycle = weeklyAiPlanStr_(body.planningCycle);
    if (!planningCycle) {
      var ctx = (typeof gapCalcResolveContext_ === 'function') ? gapCalcResolveContext_('INVENTORY') : null;
      if (ctx && ctx.ok) planningCycle = ctx.planningCycle;
    }
    if (!planningCycle) return jsonResponse_({ success: false, errors: [weeklyAiPlanErr_('PLANNING_CYCLE_UNRESOLVED', 'could not resolve canonical planning cycle')] });

    // ---- HARVEST canonical facts (LIVE-VERIFY) --------------------------------------------------------------
    // §E.2 — the client sends IDENTITY and its EXPECTED lineage/quantity; it never sends a quantity that is
    // taken as true. `expectedDemand` is optional: absent means "no expectation to reconcile", present means
    // every entry must AGREE with the canonical row or the run refuses.
    var expectedBySite = weeklyAiPlanExpectedDemand_(body, company, country);
    // §2 — the site the request names travels WITH the scope, into the harvest, where the isolation happens.
    // It was previously read only for the readback message, so a site-level request produced a
    // company/country-wide computation and the marketplace was re-attached at the very end for display. It
    // can only ever NARROW the server-owned allowlist (weeklyAiPlanTargetScopes_ intersects; it never unions).
    var requestedMarketplace = weeklyAiPlanStr_(body.currentMarketplace) || weeklyAiPlanStr_(body.requestedMarketplace);
    var h = weeklyAiPlanHarvest_(ss, { company: company, country: country, planningCycle: planningCycle,
      marketplace: requestedMarketplace }, expectedBySite);
    if (!h.ok) return jsonResponse_({ success: false, errors: h.errors || [weeklyAiPlanErr_('HARVEST_FAILED', 'fact harvest failed')] });

    // ---- MAP → (company,country) batch request (PURE, Node-verified) ---------------------------------------
    var mapped = KMWHA.mapWeeklyHarvestToBatchRequest({
      planningCycle: planningCycle,
      businessScope: { company: company, country: country, marketplace: requestedMarketplace,
        source_page: WEEKLY_AI_PLAN_SOURCE_PAGE_ },
      mode: mode, confirmRegenerateOverUserEdits: body.confirmRegenerateOverUserEdits === true,
      actor: weeklyAiPlanStr_(body.actor) || 'user', now: procurementTimestamp_(),
      sourceDataAsOf: h.sourceDataAsOf, formulaVersion: 'WEEKLY_AI_PLAN_V1',
      // §D — the harvest's own per-site drops, so the readiness result can name WHICH site and WHY
      // instead of only that the universe came out empty.
      errors: Array.isArray(h.errors) ? h.errors : [],
      factoryIdentityConfig: WEEKLY_AI_PLAN_FACTORY_IDENTITY_, warehousesById: h.warehousesById,
      kmaf: h.kmaf, horizonsByDemandRef: h.horizonsByDemandRef, poolsBySku: h.poolsBySku
    });
    // F1-7N-FC-1B-E3-R1 §D — the typed readiness answer, in the ONE place the browser can read it.
    //
    // Two separate defects were hiding behind this line. The first is that `mapped.issues` was EMPTY for the
    // live shape (fixed at the mapper). The second is that `weeklyAiPlanErr_` puts every extra field at the
    // error's TOP level, and _kmWeeklyCommand_ preserves only `code`, `message` and `details` — so even a
    // full issues array would not have reached the page. It is nested under `details` now, and the message
    // itself names the first blocking issue instead of restating the generic code.
    if (!mapped.ready) {
      // F1-7N-FC-1B-E3-R4 §G — before this is reported as a failure, ask whether it IS one.
      // R6-R7-R1 §C — ASK THE CANONICAL ROW FIRST. The verdict below opens with
      // `if (!receivers.length) return NO_RECEIVERS_BUILT`, and a scope that needs nothing builds no
      // receivers — so the one situation that most obviously means 'nothing to do' was the one it could
      // not recognise. The authority resolved in the harvest answers it directly.
      var _na0 = weeklyAiPlanK2NoAction_(h);
      if (_na0.noAction) {
        return jsonResponse_(weeklyAiPlanNoActionResponse_(_na0, {
          planning_cycle: planningCycle,
          scope: { company: company, country: country, marketplace: weeklyAiPlanStr_(body.currentMarketplace) },
          mode: mode, site_count: h.site_count == null ? null : h.site_count,
          source_data_as_of: weeklyAiPlanStr_(h.sourceDataAsOf) || null,
          recommendation_authority: h.recommendationState || null }));
      }
      var _nd = weeklyAiPlanNoDemandVerdict_(h, mapped);
      if (_nd.noDemand) {
        return jsonResponse_({
          success: true,
          data: {
            code: 'NO_REPLENISHMENT_REQUIRED',
            message: 'No replenishment is required for this scope.',
            planning_cycle: planningCycle,
            scope: { company: company, country: country, marketplace: weeklyAiPlanStr_(body.currentMarketplace) },
            site_count: h.site_count == null ? null : h.site_count,
            receiver_count: _nd.receiverCount,
            requested_qty: 0, allocated_qty: 0, route_count: 0, routes: [],
            // The page's existing zero-result classifier reads these two. A new success shape that the
            // client cannot recognise would be reported as a generic failure, which is the opposite of
            // the point; `status` and `zero_result` keep it on the path that already works.
            status: 'COMPLETED', zero_result: true, job_status: 'NO_DEMAND',
            header_created: false, line_created: false, db_writes: 0,
            demand_basis_total: _nd.basisTotal, canonical_demand_total: _nd.gapTotal,
            source_data_as_of: weeklyAiPlanStr_(h.sourceDataAsOf),
            forecast_normalization: h.forecast_normalization || null
          },
          errors: []
        });
      }
      var _rdIssues = Array.isArray(mapped.issues) ? mapped.issues : [];
      var _rdFirst = _rdIssues.filter(function (i) { return i && i.blocking !== false; })[0] || _rdIssues[0] || null;
      var _rdMsg = _rdFirst
        ? ('canonical facts not ready: ' + _rdFirst.code + (_rdFirst.field ? ' (' + _rdFirst.field + ')' : '') +
           (_rdFirst.actual ? ' — ' + _rdFirst.actual : ''))
        : 'canonical §7 facts not ready (fail closed)';
      return jsonResponse_({
        success: false,
        errors: [weeklyAiPlanErr_('HARVEST_NOT_READY', _rdMsg, {
          details: {
            stage: 'READINESS',
            readiness_reason: mapped.reason || null,
            issues: _rdIssues,
            warnings: Array.isArray(mapped.warnings) ? mapped.warnings : [],
            predicates: Array.isArray(mapped.predicates) ? mapped.predicates : [],
            harvest: { ok: h.ok === true, site_count: h.site_count == null ? null : h.site_count,
              receiver_count: h.receiver_count == null ? null : h.receiver_count,
              source_data_as_of: weeklyAiPlanStr_(h.sourceDataAsOf) },
            // §G — why this was NOT treated as an empty group. Without it, "you said zero demand is fine,
            // so why is this red" has no answer but a re-read of the source.
            no_demand_verdict: { no_demand: false, reason: _nd.reason, receiver_count: _nd.receiverCount,
              demand_basis_total: _nd.basisTotal, canonical_demand_total: _nd.gapTotal,
              positive_gap_refs: _nd.positiveGapRefs.slice(0, 20) },
            planning_cycle: planningCycle,
            scope: { company: company, country: country, marketplace: weeklyAiPlanStr_(body.currentMarketplace) },
            db_writes: 0
          }
        })]
      });
    }

    // ---- REAL persistence deps --------------------------------------------------------------------------------
    var deps = weeklyAiPlanPersistenceDeps_(ss);

    // ---- GENERATE via the K2 route-group path: per-source lines → route derivation → K2 partition → ATOMIC
    // Header+Lines write (the SAME endpoint + identity manual save uses). Reached ONLY when the flag is true.
    return weeklyAiPlanGenerateK2_(ss, mapped.request, h, deps, body);
  } catch (e) {
    return jsonResponse_({ success: false, errors: [weeklyAiPlanErr_('WEEKLY_AI_PLAN_ERROR', (e && e.message) ? String(e.message) : String(e))] });
  }
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R1 — 61_ owns the harvest, the readiness decision and the generation, and it carried NO
// build stamp: it was the one file in this chain whose sync state the deployment manifest could not report, so
// "the deployment answers HARVEST_NOT_READY with no issues" and "the deployment predates the fix" were the same
// observation. Stamped and registered in 63_'s manifest.
// R6-R7-R1 — moved because THIS FILE changed: a valid zero recommendation is now a typed success
// (AI_PLAN_NO_ACTION, zero writes) instead of a REQUESTED_SCOPE_EMPTY refusal, and the canonical demand is
// netted by the qualifying MANUAL plan before the allocator sizes anything. A stamp records the round a
// module last changed; it is not the release.
var WAP_BUILD_VERSION_ = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R2';

// F1-7N-FA-3C-R6F2 — K2 route-group generation (reached ONLY when INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = true).
// per-source lines (KMWRB.buildWeeklySourceLines) → route derivation + K2 partition (KMWRR, per marketplace) →
// ATOMIC Header+Lines write (handleUpsertShippingAllocationDraftAtomic_ — the SAME endpoint + K2 identity manual save
// uses) → readback summary. Route authorities (carrier_rate_cards + carrier_lead_times) are harvested here (the
// legacy K3 harvest did NOT load them). The per-source-line → allocatedLine assembly (window/required-by join +
// destination) is defensive: any line whose route cannot be resolved BLOCKS that group (no header/lines), and the
// read-only TEMP_R6F2_PREFLIGHT reports resolution/availability counts BEFORE any controlled live run.
// ================================================================================================================
function weeklyAiPlanReadCarrierAuthorities_(ss) {
  // F1-7N-FA-3C-R6F2B → R6F2C FIX: gapReadObjects_ returns a BARE ARRAY of row objects (not { rows: [...] }). The
  // prior `(o && o.rows) ? o.rows : []` therefore silently discarded EVERY carrier row (an array has no `.rows`),
  // feeding KMWRR an empty rateCards/leadTimes set → ROUTE_METHOD_UNRESOLVED for every line while the diagnostic
  // (which reads via TEMP_readObjects_ → { rows }) saw the full set. Accept both shapes so the transport can never
  // diverge from the diagnostic again.
  function rows(name) {
    try {
      var o = (typeof gapReadObjects_ === 'function') ? gapReadObjects_(ss, name) : null;
      return Array.isArray(o) ? o : ((o && Array.isArray(o.rows)) ? o.rows : []);
    } catch (e) { return []; }
  }
  return { rateCards: rows('carrier_rate_cards'), leadTimes: rows('carrier_lead_times') };
}
// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R4 §2 — A RATE CARD ALONE CANNOT PRODUCE A ROUTE, AND THE FUNNEL ONLY LOOKED AT CARDS.
//
// The live census reported `NO_CARRIER_CARD_FOR_LANE` and stopped there, which reads as "add one rate card and
// this lane works". Measured against the frozen route derivation, that is not true, and the difference is a
// second round of the same STOP if anyone acts on the shorter answer:
//
//   carrier_rate_cards   decides whether the lane has any CANDIDATE at all. Missing -> ROUTE_METHOD_UNRESOLVED
//                        with NO_CARRIER_CARD_FOR_LANE. This is what the funnel already measured.
//   carrier_lead_times   decides whether a candidate can be RANKED. `carrier_rate_cards` stores no transit
//                        days at all — 17_ REJECTS transit columns in the rate template by design, because
//                        lead time is maintained separately. With a card and no lead-time row, deriveRoute
//                        reaches `onTime(null) === false` for every pair and refuses with
//                        ROUTE_AUTO_RANKING_INSUFFICIENT / NO_LEAD_TIME — a DIFFERENT token, a different
//                        table, and a refusal that looks nothing like the one the operator was told to fix.
//
// So readiness is asked over BOTH authorities, on the SAME lane key, using the SAME predicates the router uses
// (KMRA's axisOk / canonicalMethodKey), and the answer names every field that is actually missing rather than
// the first one that failed. `matched_methods` is the intersection: a canonical method that a usable card
// offers AND a lead-time row can key. It is that intersection, never either side alone, that makes a lane
// routable.
//
// It reports and never writes. When the answer is no, the caller's move is USER_MASTER_DATA_REQUIRED and a
// field list — never a fabricated carrier, rate, currency or transit time.
// ================================================================================================================
function weeklyAiPlanCarrierReadiness_(rateCards, leadTimes, laneQuery, asOfOrdinal) {
  var q = { origin_country: weeklyAiPlanStr_(laneQuery && laneQuery.originCountry),
    destination_country: weeklyAiPlanStr_(laneQuery && laneQuery.destinationCountry),
    marketplace: weeklyAiPlanStr_(laneQuery && laneQuery.marketplace) };
  var out = { lane_key: q.origin_country + '|' + q.destination_country + '|' + (q.marketplace || '(any)'),
    lane_query: q, as_of_ordinal: (asOfOrdinal === undefined ? null : asOfOrdinal),
    rate_card: { authority: 'carrier_rate_cards', usable_on_lane: 0, canonical_methods: [] },
    lead_time: { authority: 'carrier_lead_times', rows_on_lane: 0, keyed_methods: [] },
    matched_methods: [], ready: false, missing: [], missing_fields: [], blocking_token: null };
  var kmra = (typeof KMRA !== 'undefined' && KMRA) ? KMRA : null;
  if (!kmra || typeof kmra.normalizeRateCard !== 'function') {
    out.missing.push('KMRA_UNAVAILABLE');
    out.blocking_token = 'KMRA_UNAVAILABLE';
    return out;
  }
  // (a) the CARD side, by the router's own predicates.
  var cardMethods = {};
  (rateCards || []).forEach(function (raw) {
    var dto = kmra.normalizeRateCard(raw);
    if (!kmra.axisOk(dto.originCountry, q.origin_country)) return;
    if (!kmra.axisOk(dto.destinationCountry, q.destination_country)) return;
    if (!kmra.axisOk(dto.marketplace, q.marketplace)) return;
    if (!kmra.rateCardUsable(dto, out.as_of_ordinal)) return;
    out.rate_card.usable_on_lane++;
    if (dto.methodKey) cardMethods[dto.methodKey] = 1;
  });
  out.rate_card.canonical_methods = Object.keys(cardMethods).sort();
  // (b) the LEAD-TIME side, on the same lane, with the same wildcard rule. A row is only usable if it can
  //     yield a number: a row present with all three day fields blank is NOT lead-time authority.
  var ltMethods = {};
  (leadTimes || []).forEach(function (raw) {
    var lt = kmra.normalizeLeadTime(raw);
    if (!kmra.axisOk(lt.originCountry, q.origin_country)) return;
    if (!kmra.axisOk(lt.destinationCountry, q.destination_country)) return;
    out.lead_time.rows_on_lane++;
    if (!lt.methodKey) return;
    if (!isFinite(lt.avgDays) && !isFinite(lt.maxDays) && !isFinite(lt.minDays)) return;
    ltMethods[lt.methodKey] = 1;
  });
  out.lead_time.keyed_methods = Object.keys(ltMethods).sort();
  // (c) the INTER§ION is the only thing that makes a lane routable.
  out.matched_methods = out.rate_card.canonical_methods.filter(function (m) { return ltMethods[m] === 1; });
  if (!out.rate_card.usable_on_lane) {
    out.missing.push('CARRIER_RATE_CARD');
    out.blocking_token = 'NO_CARRIER_CARD_FOR_LANE';
  } else if (!out.rate_card.canonical_methods.length) {
    out.missing.push('CANONICAL_SHIPPING_METHOD_ON_CARD');
    out.blocking_token = 'NO_CANONICAL_METHOD';
  }
  if (!out.lead_time.keyed_methods.length) {
    out.missing.push('CARRIER_LEAD_TIME');
    if (!out.blocking_token) out.blocking_token = 'NO_LEAD_TIME';
  } else if (!out.matched_methods.length && out.rate_card.canonical_methods.length) {
    out.missing.push('LEAD_TIME_FOR_A_METHOD_THE_CARD_OFFERS');
    if (!out.blocking_token) out.blocking_token = 'NO_LEAD_TIME';
  }
  out.ready = out.missing.length === 0 && out.matched_methods.length > 0;
  // The EXACT fields a person must supply, per table, with the enum or format each one accepts. A report that
  // says only "master data missing" leaves the reader to find 17_ and read the importer.
  if (!out.ready) out.missing_fields = weeklyAiPlanCarrierMissingFields_(q, out.missing);
  return out;
}

// The field list, derived from 17_carrier_handlers.gs's OWN create-path requirements so it cannot drift from
// what the importer will actually accept. Values are described, never invented: no carrier, rate, currency or
// transit time is suggested here.
function weeklyAiPlanCarrierMissingFields_(q, missing) {
  var out = [];
  if (missing.indexOf('CARRIER_RATE_CARD') !== -1 || missing.indexOf('CANONICAL_SHIPPING_METHOD_ON_CARD') !== -1) {
    out.push({ table: 'carrier_rate_cards',
      created_by: 'Carrier Rate Card page -> Master Template (download -> fill -> upload). Import action ' +
        '`importCarrierRateCards` with mode=master; a blank rate_card_id row CREATES. The Update Template ' +
        'cannot create rows.',
      fields: [
        { field: 'carrier_id', required: true, note: 'must already exist in `carriers`; never auto-created. carrier_name resolves to it only when unambiguous.' },
        { field: 'origin_country', required: true, value: q.origin_country },
        { field: 'destination_country', required: true, value: q.destination_country },
        { field: 'marketplace', required: false, note: 'blank = wildcard (matches any marketplace on this lane); ' + (q.marketplace ? 'or exactly "' + q.marketplace + '"' : 'no marketplace constraint needed') },
        { field: 'shipping_method', required: true, note: 'must map to a CANONICAL key or the lane cannot be lead-time joined. Mapped leading tokens: air / sea express / sea / express / courier / truck. Anything else (e.g. GROUND, RAIL) is deliberately unmapped.' },
        { field: 'last_mile_delivery', required: true, note: 'free text; must match the carrier_lead_times row below (or be blank on both).' },
        { field: 'charge_type', required: true, note: 'enum: weight | volume | container | shipment | carton' },
        { field: 'charge_unit', required: true, note: 'enum: kg | lb | cbm | 20GP | 40HQ | shipment | carton' },
        { field: 'currency', required: true, note: 'the carrier\u2019s quoted currency' },
        { field: 'unit_rate', required: true, note: 'numeric; the carrier\u2019s quoted rate' },
        { field: 'effective_from', required: true, note: 'yyyy-mm-dd; MUST cover the ship date or the card is not usable' },
        { field: 'effective_to', required: false, note: 'yyyy-mm-dd, or blank for open-ended' },
        { field: 'status', required: false, note: 'enum: active | inactive (blank is treated as active)' },
        { field: 'import_duty_treatment', required: false, note: 'enum: included_in_rate | excluded_in_rate; blank is a valid needs-completion state and is never derived' }
      ] });
  }
  if (missing.indexOf('CARRIER_LEAD_TIME') !== -1 || missing.indexOf('LEAD_TIME_FOR_A_METHOD_THE_CARD_OFFERS') !== -1) {
    out.push({ table: 'carrier_lead_times',
      created_by: 'NO GENERIC HANDLER EXISTS. `carrier_rate_cards` REJECTS transit columns by design and the ' +
        'only lead-time writer in the project is the hard-coded CN->JP Sinotrans seed. This row must be ' +
        'entered directly in the `carrier_lead_times` tab, or a maintenance handler must be added first.',
      fields: [
        { field: 'lead_time_id', required: true, note: 'CLT-###### (6-digit); next value continues the existing sequence' },
        { field: 'carrier_id', required: true, note: 'the SAME carrier as the rate card above' },
        { field: 'origin_country', required: true, value: q.origin_country },
        { field: 'destination_country', required: true, value: q.destination_country },
        { field: 'shipping_method', required: true, note: 'must resolve to the SAME canonical key as the rate card\u2019s method, or the two never join' },
        { field: 'last_mile_delivery', required: true, note: 'must match the rate card\u2019s last_mile_delivery (or be blank on both)' },
        { field: 'avg_days', required: true, note: 'numeric calendar days. avg_days is preferred; max_days/min_days are used only as a conservative fallback, so a row with all three blank is NOT authority.' },
        { field: 'min_days', required: false, note: 'numeric calendar days' },
        { field: 'max_days', required: false, note: 'numeric calendar days' }
      ] });
  }
  return out;
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R5 §5 — TRANCHE METHOD ADVICE, AND THE QUANTITY THAT MUST NOT BE COUNTED TWICE.
//
// The obvious way to offer several shipping methods is to price the whole 760 against each one. That is also
// the way to ship 2280 units: the moment a reader treats the three lines as a plan rather than as a menu, the
// quantity has tripled. So the demand is split into TRANCHES using the canonical demand windows that already
// exist (one allocated line per sku+window, each with its own required-by date), and exactly ONE method per
// tranche is COUNTED. Every other option travels as an alternative SCENARIO carrying
// `counted_in_shipment_total: false`, and the totals below are computed from the counted set alone.
//
// A tranche's urgency is its own: `days_until_stockout` is that window's required-by date minus the ship date,
// so a near-term window can take air while a far-term window takes sea, and neither borrows the other's slack.
//
// Nothing here writes, and nothing here invents. A tranche with no transit authority keeps its source, its
// quantity and its required-by date, and reports that a person must choose the method — it does not guess a
// method, an ETA or a carrier, and it does not withdraw the quantity advice it can legitimately give.
// ================================================================================================================
function weeklyAiPlanMethodAdvice_(allocatedLines, harvest, leadTimes, shipDate) {
  var out = { authority: 'KMMR', buffer: null, ship_date: weeklyAiPlanStr_(shipDate) || null,
    tranches: [], counted_quantity: 0, alternative_scenario_count: 0,
    tranches_with_method: 0, tranches_needing_review: 0,
    status: 'MANUAL_REVIEW_REQUIRED', review_reasons: [] };
  var kmmr = (typeof KMMR !== 'undefined' && KMMR) ? KMMR : null;
  if (!kmmr || typeof kmmr.recommend !== 'function') { out.authority = 'KMMR_UNAVAILABLE'; return out; }
  var cfg = (typeof weeklyAiPlanTransitBuffer_ === 'function') ? weeklyAiPlanTransitBuffer_() : null;
  var shipOrd = (typeof KMWRR !== 'undefined' && KMWRR && typeof KMWRR.dateToOrdinal === 'function')
    ? KMWRR.dateToOrdinal(shipDate) : null;
  var whById = (harvest && harvest.warehousesById) || {};
  var seenReason = {};

  (allocatedLines || []).forEach(function (a) {
    var srcId = weeklyAiPlanStr_(a.source_warehouse_id);
    var srcWh = whById[srcId] || null;
    var dest = a.destination || {};
    var lane = { originCountry: weeklyAiPlanStr_(srcWh && srcWh.country),
      destinationCountry: weeklyAiPlanStr_(dest.country) };
    var reqOrd = (typeof KMWRR !== 'undefined' && KMWRR && typeof KMWRR.dateToOrdinal === 'function')
      ? KMWRR.dateToOrdinal(a.required_by_date) : null;
    // The tranche's OWN urgency. Never the plan's, never the earliest window's.
    var dus = (reqOrd == null || shipOrd == null) ? null : (reqOrd - shipOrd);
    // The buffer is looked up per method only when a method is already known; the tranche-level lookup uses
    // the default, and KMMR re-resolves per option where an override exists.
    var buf = kmmr.bufferFor(cfg, '');
    if (!out.buffer) out.buffer = { days: buf.days, source: buf.source, provisional: buf.provisional === true,
      authority: (cfg && cfg.authority) || null, rule: (cfg && cfg.rule) || null };
    var rec = kmmr.recommend({ leadTimes: leadTimes, lane: lane, daysUntilStockout: dus,
      buffer: buf, requiredByDate: a.required_by_date, shipDate: shipDate });
    var qty = weeklyAiPlanNum_(a.recommended_qty != null ? a.recommended_qty : a.planned_qty) || 0;
    var t = {
      sku: weeklyAiPlanStr_(a.sku), site_sku: weeklyAiPlanStr_(a.site_sku),
      window_code: weeklyAiPlanStr_(a.window_code), required_by_date: weeklyAiPlanStr_(a.required_by_date),
      source_warehouse_id: srcId, destination: dest,
      lane: rec.lane, days_until_stockout: rec.days_until_stockout,
      quantity: qty,
      method_status: rec.status, review_reason: rec.review_reason,
      // THE COUNTED RECOMMENDATION. One per tranche, or none.
      recommended_method: rec.recommended ? {
        shipping_method: rec.recommended.shipping_method,
        last_mile_delivery: rec.recommended.last_mile_delivery,
        conservative_transit_days: rec.recommended.conservative_transit_days,
        arrival_headroom_days: rec.recommended.arrival_headroom_days,
        risk: rec.recommended.risk, quantity: qty, counted_in_shipment_total: true,
        carrier_ids: rec.recommended.carrier_ids, carrier_selection: rec.recommended.carrier_selection,
        estimated_cost: rec.recommended.estimated_cost, cost_basis: rec.recommended.cost_basis
      } : null,
      // SCENARIOS. Same quantity shown for comparison, and explicitly NOT part of any total.
      alternative_scenarios: (rec.alternatives || []).map(function (o) {
        return { shipping_method: o.shipping_method, last_mile_delivery: o.last_mile_delivery,
          conservative_transit_days: o.conservative_transit_days,
          arrival_headroom_days: o.arrival_headroom_days, risk: o.risk,
          quantity_if_chosen: qty, counted_in_shipment_total: false,
          carrier_ids: o.carrier_ids, carrier_selection: o.carrier_selection,
          estimated_cost: o.estimated_cost, cost_basis: o.cost_basis };
      })
    };
    out.alternative_scenario_count += t.alternative_scenarios.length;
    if (t.recommended_method) { out.counted_quantity += qty; out.tranches_with_method++; }
    else {
      out.tranches_needing_review++;
      var rr = weeklyAiPlanStr_(rec.review_reason);
      if (rr && !seenReason[rr]) { seenReason[rr] = 1; out.review_reasons.push(rr); }
    }
    out.tranches.push(t);
  });

  out.status = (out.tranches.length && out.tranches_needing_review === 0) ? 'AUTO_RECOMMENDED'
    : (out.tranches_with_method > 0 ? 'PARTIAL_MANUAL_REVIEW_REQUIRED' : 'MANUAL_REVIEW_REQUIRED');
  return out;
}

// ================================================================================================================
// §1/§6/§8 — THREE LAYERS, THREE VERDICTS. ONE READINESS ANSWER WAS SERVING ALL OF THEM.
//
// R4 returned STOP for the whole AI Plan because one lane had no Carrier Rate Card. Quantity and source were
// correct, computed, and thrown away with the verdict. That happened because a single verdict was answering
// three different questions owned by three different layers, and the strictest one won by default.
//
// They are separated here, and a consumer must switch on the one it owns:
//
//   recommendation_ready          Layer 1. Can we advise WHAT and HOW MUCH, from WHERE, by WHEN?
//   supply_allocation_ready       Layer 1. Is the source split conserved and within available stock?
//   method_status                 Layer 1. Is the transport method advisable, or does a person choose it?
//   carrier_pricing_ready         Layer 2. Are rate cards available to compare carriers? NEVER blocks Layer 1.
//   execution_route_materialized  can a schema-COMPLETE execution route be written right now?
//   submit_ready                  Layer 3. The only layer permitted to refuse for incomplete mandatory fields.
//
// A SHARED blocker — snapshot, forecast authority, schema/runtime authority, demand mapping, quantity
// conservation — still STOPs, because those make the numbers themselves untrustworthy. Carrier coverage does
// not, and `carrier_coverage_is_not_a_shared_blocker` is asserted in the output so that rule is visible rather
// than implied by its absence.
// ================================================================================================================
// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6 §4 — WHERE THE UNITS COME FROM, BY NAME.
//
// "AI Plan suggests 760 units" is not advice anybody can act on. "760 units from WH-RESUS-US-3PL-AMZLGS
// (AMZLGS), 0 from a factory" is. The split matters more than the total on this scope in particular, because
// the whole quantity is already sitting in an in-country 3PL — a fact that changes what an operator does next,
// and one the page had no way to state.
//
// The FACTORY total is emitted even when it is zero, and especially when it is zero. A source list that simply
// omits factories reads as "we did not look"; a stated 0 reads as "we looked, and nothing needs to come from
// one", which is the actual answer here and a reassuring one.
// ================================================================================================================
function weeklyAiPlanAdviceSources_(allocatedLines, harvest) {
  var whById = (harvest && harvest.warehousesById) || {};
  var byWh = {}, order = [], factoryQty = 0, nonFactoryQty = 0;
  (allocatedLines || []).forEach(function (a) {
    var id = weeklyAiPlanStr_(a.source_warehouse_id);
    var qty = weeklyAiPlanNum_(a.recommended_qty != null ? a.recommended_qty : a.planned_qty) || 0;
    if (!byWh[id]) {
      var w = whById[id] || null;
      byWh[id] = { warehouse_id: id,
        warehouse_code: weeklyAiPlanStr_(w && (w.warehouse_code || w.code)) || null,
        warehouse_type: weeklyAiPlanStr_(w && w.warehouse_type) || null,
        country: weeklyAiPlanStr_(w && w.country) || null,
        is_factory: !!(w && (w.is_factory_warehouse === true
          || String(w.is_factory_warehouse).trim().toLowerCase() === 'true')),
        quantity: 0 };
      order.push(id);
    }
    byWh[id].quantity += qty;
  });
  var list = order.map(function (id) { return byWh[id]; });
  list.forEach(function (r) { if (r.is_factory) factoryQty += r.quantity; else nonFactoryQty += r.quantity; });
  return { by_warehouse: list, factory_quantity: factoryQty, non_factory_quantity: nonFactoryQty,
    factory_quantity_is_measured_not_omitted: true };
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6 §8 — WHAT A LIVE ACTIVATION WOULD ACTUALLY TOUCH.
//
// "It may create some data" is not a manifest, it is a shrug, and it is not something anyone can approve. This
// states every table by name and which side of the line it is on, so a person deciding whether to enable the
// flag is reading a contract rather than a reassurance — and so the round AFTER activation can compare
// before -> generate -> readback -> replay -> after against a statement made BEFORE the fact.
//
// It is a DECLARATION, deliberately. It is emitted by the same file that performs the writes, it names the two
// tables that file writes and the exact handler it writes them through, and the regression suite asserts the
// declaration against what a simulated activation actually does. A manifest checked only by reading is a
// manifest that drifts.
//
// REPLAY. A second identical run is NOT a second ticket: the K2 identity is deterministic, so a replay resolves
// the same execution key and REUSEs or UPDATEs the same header. That is the property the round before this one
// established, and it is restated here because it is the single fact that makes an activation test reversible.
// ================================================================================================================
function weeklyAiPlanActivationManifest_() {
  return {
    contract: 'F1-7N-FC-1B-E3-R4-A2-R1-R6 §8 — the exact mutation surface of one controlled AI Plan activation',
    flag: { name: 'INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_',
      value: (typeof inventoryAiPlanDbGenerationEnabled_ === 'function') ? inventoryAiPlanDbGenerationEnabled_() : null,
      scope_allowlist: (typeof INVENTORY_AI_PLAN_ACTIVATION_ALLOWLIST_ !== 'undefined')
        ? INVENTORY_AI_PLAN_ACTIVATION_ALLOWLIST_ : null },
    tables_read: ['inventory_replenishment_gap', 'warehouses', 'sku_details', 'marketplace_skus', 'marketplaces',
      'overseas_inventory_snapshot', 'factory_stock', 'fc_regular_forecast', 'carrier_rate_cards',
      'carrier_lead_times', 'shipping_allocation_drafts', 'shipping_allocation_draft_lines'],
    tables_written: ['shipping_allocation_drafts', 'shipping_allocation_draft_lines'],
    write_handler: 'handleUpsertShippingAllocationDraftAtomic_ (16_shipping_allocation_handlers.gs) — the ONLY '
      + 'path to a write; one lock, one header + its lines, all or nothing',
    expected_rows_inserted: 'one shipping_allocation_drafts header per K2 route group whose identity does not '
      + 'already exist, plus one shipping_allocation_draft_lines row per (sku, window) in that group',
    expected_rows_updated: 'an existing header with the SAME deterministic execution key is UPDATED in place, '
      + 'never duplicated; superseded AI headers of the same scope are marked expired AFTER this run verifies',
    tables_guaranteed_zero_mutation: ['shipping_plans', 'shipping_plan_lines', 'shipments', 'shipment_lines',
      'factory_stock_movements', 'reservations', 'purchase_orders', 'purchase_order_lines',
      'carrier_rate_cards', 'carrier_lead_times', 'inventory_replenishment_gap', 'warehouses', 'sku_details'],
    reservation_expected: false,
    reservation_note: 'An AI Plan draft reserves NOTHING. Reservation belongs to the canonical shipment '
      + 'lifecycle downstream of Submit, and no code path here reaches it.',
    submit_expected: false,
    submit_note: 'Generation writes a DRAFT. Submit is a separate operator action with its own gate, and that '
      + 'gate is unchanged by this round.',
    replay_behavior: 'IDEMPOTENT BY IDENTITY. A repeated generation for the same scope resolves the same '
      + 'deterministic execution key and REUSEs or UPDATEs the same header. A replay must not change '
      + 'created_headers, and must not raise the row count in either written table.',
    readback_procedure: 'After the run, read shipping_allocation_drafts and shipping_allocation_draft_lines '
      + 'filtered to the scope and generation_run_id, and compare header count, line count and unit total '
      + 'against created_headers / created_lines / the advice quantities in this same response.',
    rollback_procedure: 'Non-destructive. The written headers are DRAFTS and carry their generation_run_id: '
      + 'mark them expired through the same lifecycle that supersedes them (aiplExpireSupersededDrafts_). '
      + 'No row in any other table was changed, so nothing else needs undoing. Never delete rows by hand.',
    comparison_points: ['before', 'generate', 'readback', 'replay', 'after']
  };
}

function weeklyAiPlanAdviceStatus_(input) {
  input = input || {};
  var sharedBlockers = (input.shared_blockers || []).slice();
  var completeness = input.completeness || null;
  var advice = input.method_advice || null;
  var out = {
    contract: 'F1-7N-FC-1B-E3-R4-A2-R1-R5 §1 — AI Plan / Weekly Shipping Plan / Submit are three layers with '
      + 'three verdicts; a Carrier gap is a WARNING at layer 1 and a refusal only at layer 3',
    shared_blockers: sharedBlockers,
    carrier_coverage_is_not_a_shared_blocker: true,
    // R6 §3 — the ONLY classes of fault that may stop the whole AI Plan, enumerated. A reader can check that
    // a token they are looking at is absent from this list instead of inferring the rule from silence, and a
    // future round that wants to add a stop has to add it HERE, in the open, rather than by an early return.
    shared_blocker_classes: ['DEPLOYMENT_OR_RUNTIME_AUTHORITY_MISMATCH', 'SNAPSHOT_UNAVAILABLE',
      'FORECAST_NORMALIZATION_FAILURE', 'SCOPE_MAPPING_FAILURE', 'QUANTITY_CONSERVATION_FAILURE',
      'SCHEMA_INCOMPATIBLE', 'CORRUPTED_DETERMINISTIC_IDENTITY'],
    // …and the ones that may NEVER stop it. Every entry here is a carrier- or route-coverage fact: real,
    // reportable, actionable, and owned by Layer 2 or Layer 3.
    never_a_shared_blocker: ['NO_TRANSIT_AUTHORITY_FOR_LANE', 'NO_CARRIER_CARD_FOR_LANE',
      'CARRIER_PRICING_DEFERRED', 'ROUTE_METHOD_MANUAL_REVIEW_REQUIRED', 'MANUAL_ROUTE_SELECTION_REQUIRED',
      'MANUAL_CARRIER_SELECTION_REQUIRED', 'EXECUTION_ROUTE_NOT_MATERIALIZED', 'USER_MASTER_DATA_REQUIRED'],
    supply_allocation_ready: !!(completeness && completeness.supply_allocation_conserved === true),
    authorized_quantity: completeness ? completeness.authorized_quantity : null,
    supply_allocated_quantity: completeness ? completeness.supply_allocated_quantity : null,
    unresolved_supply_quantity: 0,
    // R6 §2 — the ROUTE axis, carried beside the supply axis so a consumer never has to derive one from the
    // other. Populated from KMWRR's completeness below; null when there is no completeness to read.
    automatic_route_quantity: null,
    manual_route_review_quantity: null,
    unresolved_route_quantity: null,
    execution_route_materialized_quantity: null,
    route_materialization_complete: false,
    recommendation_ready: false,
    method_status: advice ? advice.status : 'MANUAL_REVIEW_REQUIRED',
    method_review_reasons: advice ? (advice.review_reasons || []) : [],
    carrier_pricing_ready: input.carrier_pricing_ready === true,
    execution_route_materialized: false,
    execution_route_blockers: [],
    submit_ready: false,
    // R6 §3 — the typed list a consumer branches on, the flat codes for a presence test, and the prose list
    // kept under its original name for the consumers that already read it.
    recommendation_warnings: [],
    recommendation_warning_codes: [],
    route_materialization_warnings: [],
    warnings: [],
    verdict: 'STOP'
  };
  // Supply is UNRESOLVED only when the allocator could not source it — never when a carrier is missing.
  var auth = Number(out.authorized_quantity);
  var alloc = Number(out.supply_allocated_quantity);
  out.unresolved_supply_quantity = (isFinite(auth) && isFinite(alloc)) ? (auth - alloc) : null;
  // R6 §2 — the ROUTE axis, read straight from KMWRR so this function never computes a second opinion about
  // a number the allocator already decided.
  function q(name) {
    if (!completeness) return null;
    var v = Number(completeness[name]);
    return isFinite(v) ? v : null;
  }
  out.automatic_route_quantity = q('automatic_route_quantity');
  out.manual_route_review_quantity = q('manual_route_review_quantity');
  out.unresolved_route_quantity = q('unresolved_route_quantity');
  out.execution_route_materialized_quantity = q('execution_route_materialized_quantity');
  out.route_materialization_complete = !!(completeness && completeness.route_materialization_complete === true);

  // Layer 1 is ready when the numbers exist and are trustworthy. The method is a PROPERTY of the advice, not
  // a precondition for giving it.
  // NOTE the absent clause. An earlier draft also required the METHOD advice to have produced tranches, which
  // quietly recreated the very coupling this round exists to remove: a scope whose transport advice could not
  // be computed would have reported its QUANTITY advice as not ready. Layer 1's recommendation readiness is
  // about the numbers — is the demand authorized, and is the source split conserved — and the method is a
  // property OF the advice with a status of its own.
  out.recommendation_ready = sharedBlockers.length === 0
    && out.supply_allocation_ready === true
    && isFinite(auth) && auth > 0;
  // The advice authority being unavailable is a real fact and is reported, but it is a METHOD-layer fact.
  if (!advice || advice.authority === 'KMMR_UNAVAILABLE' || advice.authority === 'METHOD_ADVICE_AUTHORITY_UNAVAILABLE') {
    out.method_status = 'MANUAL_REVIEW_REQUIRED';
    out.method_review_reasons = ['METHOD_ADVICE_AUTHORITY_UNAVAILABLE'];
  }

  // Materialization is stricter and stays fail-closed: a route is written only when it is schema-COMPLETE.
  var routeCount = completeness ? Number(completeness.route_count) : 0;
  out.execution_route_materialized = out.recommendation_ready && isFinite(routeCount) && routeCount > 0
    && completeness.fully_routable === true;
  if (!out.execution_route_materialized && completeness) {
    out.execution_route_blockers = (completeness.blocker_tokens || []).slice();
  }
  // Layer 3. Named here so its condition is visible, and deliberately NOT satisfied by advice alone.
  out.submit_ready = out.execution_route_materialized === true && out.carrier_pricing_ready === true;

  // ==============================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R6 §3 — A WARNING WITH NO CODE IS A SENTENCE, AND A SENTENCE CANNOT BE SWITCHED ON.
  //
  // R5's warnings were prose. Prose is what an operator should READ, but it is not what a consumer can BRANCH
  // on, and the frontend proved it: with nothing typed to test, the page fell through to its failure wording
  // and told an operator the AI Plan had found nothing, next to a server response holding a complete
  // recommendation for 760 units. A consumer forced to regex a sentence will eventually get it wrong, and when
  // it does the operator is told the opposite of the truth.
  //
  // So every warning is now { code, owner, detail }: the CODE is the contract, the OWNER says which layer must
  // act, and the DETAIL is the sentence a person reads. `recommendation_warning_codes` is the flat list for the
  // consumer that only wants to ask "is this one present".
  //
  // NONE of these may stop the AI Plan. They are named in `never_a_shared_blocker` above, and this function has
  // exactly one road to STOP: a shared blocker, or numbers it could not compute.
  // ==============================================================================================================
  function warn(code, owner, detail) {
    out.recommendation_warnings.push({ code: code, owner: owner, detail: detail });
    if (out.recommendation_warning_codes.indexOf(code) === -1) out.recommendation_warning_codes.push(code);
    // The prose list stays, unchanged in shape, because existing consumers read it and a round that fixes a
    // reporting boundary must not break the reports that already work.
    out.warnings.push(code + ': ' + detail);
  }

  // The typed route causes, promoted from KMWRR's tokens. These are the actionable half — an operator acts on
  // "no transit authority for this lane", never on "method unresolved" — so each is surfaced under its own code
  // rather than buried inside one summary string.
  (out.execution_route_blockers || []).forEach(function (tok) {
    if (tok === 'NO_TRANSIT_AUTHORITY_FOR_LANE') {
      warn('NO_TRANSIT_AUTHORITY_FOR_LANE', 'CARRIER_MASTER_DATA',
        'no carrier_lead_times row covers this lane, so no transit time exists to judge a method against. '
        + 'The quantity and source advice stand. That table has no generic write handler: the row is entered '
        + 'directly in the tab.');
    } else if (tok === 'NO_CARRIER_CARD_FOR_LANE') {
      warn('NO_CARRIER_CARD_FOR_LANE', 'WEEKLY_SHIPPING_PLAN',
        'no carrier_rate_cards row covers this lane. Carrier comparison is unavailable; the method and the '
        + 'quantity advice do not depend on it.');
    }
  });
  if (advice && advice.status !== 'AUTO_RECOMMENDED') {
    warn('ROUTE_METHOD_MANUAL_REVIEW_REQUIRED', 'OPERATOR',
      'the AI did not select a shipping method on its own evidence (' + advice.status
      + (advice.review_reasons.length ? '; ' + advice.review_reasons.join(',') : '')
      + '). A person chooses the method; nothing about the quantity or the source is in question.');
    warn('MANUAL_ROUTE_SELECTION_REQUIRED', 'OPERATOR',
      'the execution route for this scope is completed by hand once a method is chosen.');
  }
  if (!out.carrier_pricing_ready) {
    // R6 §3 — DEFERRED, not UNAVAILABLE. "Unavailable" describes a thing that failed; nothing failed here.
    // Carrier selection is Layer 2's decision and has not been made yet, which is the normal state of a plan
    // at Layer 1 and is exactly what `carrier_selection: DEFERRED_TO_WEEKLY_SHIPPING_PLAN` already says.
    warn('CARRIER_PRICING_DEFERRED', 'WEEKLY_SHIPPING_PLAN',
      'no usable carrier_rate_cards row covers this lane, so no price is claimed and no carrier is named. '
      + 'Carrier choice belongs to the Weekly Shipping Plan and does NOT block the AI Plan recommendation.');
    warn('MANUAL_CARRIER_SELECTION_REQUIRED', 'WEEKLY_SHIPPING_PLAN',
      'a person selects the carrier for this lane until a rate card covers it.');
  }
  if (!out.execution_route_materialized) {
    warn('EXECUTION_ROUTE_NOT_MATERIALIZED', 'OPERATOR',
      (out.execution_route_blockers.join(',') || 'route identity incomplete')
      + '. Quantity and source advice stand; no partial execution route is written, and the Execution Plan '
      + 'already on screen is not changed.');
  }
  if (advice && advice.buffer && advice.buffer.provisional === true) {
    // Kept, and it should now never fire: R6 §1 confirmed the buffer. If a deployment ever resurrects a
    // provisional config this says so rather than letting an unconfirmed number pass silently.
    warn('TRANSIT_BUFFER_PROVISIONAL', 'BUSINESS',
      'safety used a provisional ' + advice.buffer.days + '-day operational buffer. R6 §1 confirmed 7 calendar '
      + 'days as the Phase 1 default; a provisional buffer here means the deployed config is behind.');
  }
  // §3 — the compatibility alias, renamed at the point where it is emitted. These were never BLOCKERS of the
  // AI Plan; they are the reasons an execution route did not form, and the old name said the opposite.
  out.route_materialization_warnings = (out.execution_route_blockers || []).slice();
  out.verdict = sharedBlockers.length ? 'STOP'
    : (out.recommendation_ready
        ? (out.recommendation_warnings.length ? 'RECOMMENDATION_READY_WITH_WARNINGS' : 'RECOMMENDATION_READY')
        : 'STOP');
  return out;
}

function weeklyAiPlanShipDate_(harvest) {
  var v = harvest && harvest.sourceDataAsOf ? String(harvest.sourceDataAsOf) : '';
  var m = v.match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : '';
}
// Map the per-source WSA lines → KMWRR allocatedLines. Confirmed fact fields: masterSku, marketplace,
// sourceWarehouseId, recommendedQty, unitsPerCarton, demandKey. window/required_by joined from horizonsByDemandRef;
// destination resolved via KMWHA.resolveWorkspaceLineDestination when available, else the line's own dest fields.
// F1-7N-FA-3C-R6F2C — CANONICAL destination classification for a WSA line. The prior code called
// KMWHA.resolveWorkspaceLineDestination(l) with the WRONG field names (it reads warehouseId/destinationRefId/
// marketplaceId/destinationType; the WSA line has destinationWarehouseId/marketplace/country) and then read the
// result via `d.destinationKind` (the resolver returns `destinationType`), so it ALWAYS fell back to a WAREHOUSE
// default carrying l.destinationWarehouseId — which for platform_fulfilled/FBA lines is a MARKETPLACE_ID, never a
// real warehouse (→ concrete=0/logical=0/missing=176). We classify at the adapter from the signals the WSA line
// actually carries: `destinationWarehouseId` is a concrete WAREHOUSE only if it is a genuine ACTIVE warehouse in the
// harvested index; otherwise, if a canonical marketplace token exists, it is a LOGICAL MARKETPLACE; otherwise BLOCK.
// A string that merely looks like a warehouse id is NEVER auto-resolved — it must match an active warehouse row.
function weeklyAiPlanWhActive_(w) {
  if (!w) return false;
  var a = String(w.is_active == null ? '' : w.is_active).trim().toLowerCase();
  return !(a === 'false' || a === 'no' || a === '0' || w.is_active === false);
}
function weeklyAiPlanClassifyDestination_(l, whById) {
  function s(v) { return String(v == null ? '' : v).trim(); }
  var ref = s(l.destinationWarehouseId), mkt = s(l.marketplace), country = s(l.country);
  if (ref) {
    var w = whById[ref];
    if (w && weeklyAiPlanWhActive_(w)) return { kind: 'WAREHOUSE', warehouse_id: ref, country: country || s(w.country), matched_by: 'active_warehouse_id' };
  }
  if (mkt) return { kind: 'MARKETPLACE', marketplace: mkt, marketplace_ref: ref, country: country, matched_by: 'marketplace_token' };
  return { kind: '', reason: 'DESTINATION_UNRESOLVED' };
}
// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R3 §4 — WHICH SIDE OF THE SHIPMENT IS THIS WAREHOUSE ON?
//
// The live census reported three facts that could not all be true of one route: the SOURCE candidate was
// WH-RESUS-US-3PL-AMZLGS, the DESTINATION was marketplace Amazon with a blank warehouse, and the allocator's
// conservation showed the quantity coming from WH-TW-CN-FACTORY-YOUXIN.
//
// Two of those three turned out to be reported wrongly rather than computed wrongly, and the third is not a
// defect at all:
//
//   * The 3PL IS a legitimate SUPPLY pool. The frozen allocator runs the overseas shared pool FIRST and the
//     factory passes over its residual (supply-planning-weekly-source-allocation.js, PASS 1 then PASS 2/3),
//     so in-country 3PL stock covering an FBA shortage is the designed behaviour, not a direction inversion.
//     It is never treated as a FACTORY: its pool type is THREE_PL and its stage token is SOURCE_OVERSEAS.
//   * What WAS broken is that a line supplied by MORE THAN ONE pool collapsed to `sourceWarehouseId: null`
//     and blocked as ROUTE_SOURCE_MULTI_POOL_UNRESOLVED — so the allocator's own per-source decision was
//     computed, thrown away, and then reported as an unresolvable ambiguity. See the split below.
//   * And the census printed the FIRST candidate of a line that had already blocked, beside a conservation
//     total from the group that had not, which is how one route came to have two different sources.
//
// This function is the authority that makes the direction DECIDABLE instead of implied. It uses the warehouse
// master and the frozen factory identity config — never a name pattern, never a substring of an id.
function weeklyAiPlanWarehouseRole_(id, whById, factoryIdentity) {
  var wid = weeklyAiPlanStr_(id);
  if (!wid) return { role: '', reason: 'WAREHOUSE_ID_MISSING' };
  var w = (whById || {})[wid];
  if (!w) return { role: '', reason: 'WAREHOUSE_NOT_IN_MASTER' };
  if (!weeklyAiPlanWhActive_(w)) return { role: '', reason: 'WAREHOUSE_INACTIVE' };
  // The frozen factory identity config is the authority on which warehouses are factories, and the warehouse
  // master's own flag/type must agree with it. A disagreement is reported, never resolved by preference.
  var declared = false;
  for (var k in (factoryIdentity || {})) {
    if (Object.prototype.hasOwnProperty.call(factoryIdentity, k) && weeklyAiPlanStr_(factoryIdentity[k]) === wid) { declared = true; break; }
  }
  var flagged = String(w.is_factory_warehouse) === 'true' || w.is_factory_warehouse === true
    || weeklyAiPlanStr_(w.warehouse_type).toUpperCase() === 'FACTORY';
  if (declared && !flagged) return { role: 'FACTORY', reason: 'FACTORY_IDENTITY_MASTER_DISAGREEMENT', warehouse: w };
  if (declared) return { role: 'FACTORY', reason: null, warehouse: w };
  if (flagged) return { role: 'FACTORY_UNDECLARED', reason: 'FACTORY_NOT_IN_IDENTITY_CONFIG', warehouse: w };
  return { role: 'NON_FACTORY', reason: null, warehouse: w };
}

// ================================================================================================================
// §4/§8 — THE ALLOCATOR ALREADY DECIDED THE SPLIT. CARRY IT.
//
// R6F2C deferred this deliberately ("a deterministic per-source whole-carton split from allocationBreakdown is
// possible but changes the generated line grain, so it is DEFERRED to a controlled generation round"). This is
// that round, and the deferral is what the live refusal was: the target SKU's 760 units were supplied 460 from
// the CN factory and 300 from the 3PL, the adapter could not name ONE source, and the whole line blocked.
//
// No new policy is introduced here and none is needed. The pools were already RANKED by the frozen allocator
// (overseas pass, then CN_YOUXIN, then TW_SHENGYI) and the breakdown is emitted in that order, so the order is
// the existing policy. This function only converts each source's already-decided quantity into WHOLE CARTONS
// while preserving the line's total exactly:
//
//   * breakdown entries are AGGREGATED per source warehouse first — the overseas pool can emit two entries
//     for one warehouse (sequence 0 and 1), and splitting on entries rather than warehouses would create two
//     lines with the same (sku, window, source) in one group, which is a duplicate by construction;
//   * each source takes the whole cartons it can fill from its own allocated quantity;
//   * any cartons still unassigned — the arithmetic of flooring several partial cartons — are handed out in
//     the allocator's own order, one at a time, only to sources that still hold a partial carton.
//
// Sum(parts) === floor(qty / upc) * upc === the line's recommendedQty. Nothing is invented and nothing is
// dropped; a source may end up holding under one carton more than its raw allocation, which is inherent to
// shipping whole cartons and is already the accepted FLOOR contract upstream.
function weeklyAiPlanSplitBySource_(l, qty, upc) {
  var bd = Array.isArray(l.allocationBreakdown) ? l.allocationBreakdown : [];
  var agg = {}, order = [];
  for (var i = 0; i < bd.length; i++) {
    var b = bd[i] || {};
    var id = weeklyAiPlanStr_(b.sourceWarehouseId);
    if (!id) continue;
    var q = Number(b.allocatedQty);
    if (!isFinite(q) || q <= 0) continue;
    if (agg[id] === undefined) { agg[id] = 0; order.push(id); }
    agg[id] += q;
  }
  if (!order.length) return { ok: false, reason: 'NO_CONCRETE_SOURCE_IN_BREAKDOWN', parts: [] };
  var u = Number(upc);
  if (!isFinite(u) || u <= 0) return { ok: false, reason: 'UNITS_PER_CARTON_UNRESOLVED', parts: [] };
  var cartonsTotal = Math.floor(Number(qty) / u);
  if (!isFinite(cartonsTotal) || cartonsTotal <= 0) return { ok: false, reason: 'NO_WHOLE_CARTON_TO_SHIP', parts: [] };
  var parts = [], assigned = 0;
  order.forEach(function (id) {
    var c = Math.floor(agg[id] / u);
    if (c > cartonsTotal - assigned) c = cartonsTotal - assigned;
    parts.push({ warehouse_id: id, allocated_qty: agg[id], cartons: c });
    assigned += c;
  });
  var guard = 0;
  while (assigned < cartonsTotal && guard < 1000) {
    var progressed = false;
    for (var pi = 0; pi < parts.length && assigned < cartonsTotal; pi++) {
      if (parts[pi].allocated_qty - parts[pi].cartons * u > 0) { parts[pi].cartons++; assigned++; progressed = true; }
    }
    if (!progressed) break;
    guard++;
  }
  if (assigned !== cartonsTotal) return { ok: false, reason: 'SOURCE_SPLIT_NOT_CONSERVING', parts: [] };
  return { ok: true, reason: null, units_per_carton: u, cartons_total: cartonsTotal,
    parts: parts.filter(function (p) { return p.cartons > 0; }).map(function (p) {
      return { warehouse_id: p.warehouse_id, qty: p.cartons * u, cartons: p.cartons, allocated_qty: p.allocated_qty }; }) };
}

// ================================================================================================================
// §7 — WHY NO CARRIER CARD MATCHED, STAGE BY STAGE, IN THE AUTHORITY'S OWN PREDICATES.
//
// The live run ended in ROUTE_METHOD_UNRESOLVED with `matched_carrier_cards = 0` against 294 rate cards, and
// the only thing either the generation or the census could say was the token itself. That is not enough to act
// on: "there is no lane in the master data" and "the lane exists but every card expired" need opposite
// responses, and neither is "re-sync the code".
//
// So the funnel is computed with KMRA's OWN normalize/match/usable predicates — not a private re-match, which
// is how a diagnostic comes to disagree with the transport — and it reports the EXACT canonical lane key it
// asked for beside the count that survived each stage.
function weeklyAiPlanCarrierFunnel_(rateCards, laneQuery, asOfOrdinal) {
  var out = { lane_query: { origin_country: weeklyAiPlanStr_(laneQuery && laneQuery.originCountry),
      destination_country: weeklyAiPlanStr_(laneQuery && laneQuery.destinationCountry),
      marketplace: weeklyAiPlanStr_(laneQuery && laneQuery.marketplace) },
    as_of_ordinal: (asOfOrdinal === undefined ? null : asOfOrdinal),
    total: 0, source_matched: 0, destination_matched: 0, marketplace_matched: 0,
    route_matched: 0, status_and_effective_matched: 0, method_present: 0,
    canonical_method_matched: 0, method_unmapped: 0, final_eligible: 0,
    distinct_methods: [], unmapped_method_sample: [], nearest_candidates: [], authority: null };
  var kmra = (typeof KMRA !== 'undefined' && KMRA) ? KMRA : null;
  if (!kmra || typeof kmra.normalizeRateCard !== 'function' || typeof kmra.axisOk !== 'function') {
    out.authority = 'KMRA_UNAVAILABLE';
    return out;
  }
  out.authority = 'KMRA';
  var q = out.lane_query, methods = {}, near = [];
  (rateCards || []).forEach(function (raw) {
    out.total++;
    var dto = kmra.normalizeRateCard(raw);
    var okO = kmra.axisOk(dto.originCountry, q.origin_country);
    var okD = kmra.axisOk(dto.destinationCountry, q.destination_country);
    var okM = kmra.axisOk(dto.marketplace, q.marketplace);
    if (okO) out.source_matched++;
    if (okD) out.destination_matched++;
    if (okM) out.marketplace_matched++;
    if (!(okO && okD && okM)) {
      // The closest misses, so a report can say WHICH axis differed and what value the data holds.
      if (near.length < 10 && ((okO && okD) || (okO && okM) || (okD && okM))) {
        near.push({ rate_card_id: dto.rateCardId, origin_country: dto.originCountry,
          destination_country: dto.destinationCountry, marketplace: dto.marketplace,
          shipping_method: dto.shippingMethod, status: dto.status,
          effective_from: dto.effectiveFrom, effective_to: dto.effectiveTo,
          failed_axis: !okO ? 'origin_country' : (!okD ? 'destination_country' : 'marketplace') });
      }
      return;
    }
    out.route_matched++;
    if (!kmra.rateCardUsable(dto, out.as_of_ordinal)) {
      if (near.length < 10) near.push({ rate_card_id: dto.rateCardId, origin_country: dto.originCountry,
        destination_country: dto.destinationCountry, marketplace: dto.marketplace,
        shipping_method: dto.shippingMethod, status: dto.status,
        effective_from: dto.effectiveFrom, effective_to: dto.effectiveTo,
        failed_axis: 'status_or_effective_window' });
      return;
    }
    out.status_and_effective_matched++;
    if (!dto.shippingMethod) return;
    out.method_present++;
    // A card can carry a method token the CANONICAL authority does not map (only Air / Sea Express / Sea /
    // Courier / Truck are mapped; Rail and anything else are deliberately unmapped). Such a card matches the
    // lane and is usable, so it counts as eligible for RANKING — but it has no lead-time key, which surfaces
    // later as ROUTE_AUTO_RANKING_INSUFFICIENT / NO_LEAD_TIME rather than as a lane problem. Those two are
    // different findings and a funnel that could not tell them apart would send the reader to the wrong table.
    if (!dto.methodKey) {
      out.method_unmapped++;
      if (out.unmapped_method_sample.length < 10) {
        out.unmapped_method_sample.push({ rate_card_id: dto.rateCardId, shipping_method: dto.shippingMethod });
      }
    } else {
      out.canonical_method_matched++;
      methods[dto.shippingMethod] = 1;
    }
    out.final_eligible++;
  });
  out.distinct_methods = Object.keys(methods).sort();
  out.nearest_candidates = near;
  // The precise missing key, so the answer is never only the token.
  out.missing_canonical_key = out.final_eligible ? null
    : { origin_country: q.origin_country, destination_country: q.destination_country,
        marketplace: q.marketplace, needs: 'an ACTIVE carrier_rate_cards row on this lane, effective on the ship date, carrying a canonical shipping_method',
        cause: !out.route_matched ? 'NO_CARRIER_CARD_FOR_LANE'
          : (!out.status_and_effective_matched ? 'CARD_INACTIVE_OR_OUTSIDE_EFFECTIVE_DATE' : 'NO_CANONICAL_METHOD') };
  // The lane HAS cards but none of their method tokens is canonical, so nothing on it can be lead-time keyed.
  out.unmapped_method_only = (out.final_eligible > 0 && out.canonical_method_matched === 0) ? {
    origin_country: q.origin_country, destination_country: q.destination_country, marketplace: q.marketplace,
    cause: 'METHOD_TOKEN_NOT_CANONICAL', sample: out.unmapped_method_sample.slice(0, 5),
    needs: 'a shipping_method the route authority maps (Air / Sea Express / Sea / Courier / Truck), or an alias rule for this token'
  } : null;
  return out;
}

function weeklyAiPlanK2AllocatedLines_(lines, harvest) {
  var horizons = (harvest && harvest.horizonsByDemandRef) || {};
  var whById = (harvest && harvest.warehousesById) || {};
  var factoryIdentity = (typeof WEEKLY_AI_PLAN_FACTORY_IDENTITY_ !== 'undefined') ? WEEKLY_AI_PLAN_FACTORY_IDENTITY_ : {};
  function s(v) { return String(v == null ? '' : v).trim(); }
  var out = [];
  var diag = { input_lines: 0, emitted_lines: 0, horizon_join_hits: 0, horizon_join_misses: 0,
    horizon_miss_sample: [], window_blank: 0, split_lines: 0, split_parts: 0, split_refused: [],
    source_roles: {}, destination_roles: {} };
  (lines || []).forEach(function (l) {
    if (!l || s(l.blockedReason)) return;                              // blocked upstream → no line
    diag.input_lines++;
    var qty = (typeof l.recommendedQty === 'number') ? l.recommendedQty : Number(l.recommendedQty);
    if (!isFinite(qty) || qty <= 0) return;                           // zero recommendation → no line
    // ============================================================================================================
    // F1-7N-FC-1B-E3-R4-A2-R1-R3 §3 — THE HORIZON JOIN NEVER MATCHED, SO EVERY LINE HAD A BLANK WINDOW.
    //
    // This looked up `horizonsByDemandRef[l.demandKey]`. Those are two DIFFERENT keys and they never met:
    //
    //   horizonsByDemandRef is keyed  company|country|marketplace|sku|destination   (61_ builds it)
    //   KMWRB's demandKey is          sku|marketplace|windowCode                    (the source allocator)
    //
    // So `hz` was ALWAYS null, and with it `window_code` and `required_by_date` were ALWAYS blank — on every
    // line, in every scope, since the join was written. Three consequences, all of them live:
    //
    //   1. Two windows of one sku (D30 and D90) both became (sku, '') and landed in the SAME route group with
    //      the SAME conservation key, which is exactly the `duplicate_sku_window_in_group` the census
    //      reported. `conserved:false` followed from a blank string.
    //   2. `required_by_date` was blank, so KMWRR's on-time ranking degraded to "does any lead time exist"
    //      and no route was ever checked against the date it is needed by.
    //   3. window_code is part of the line grain, so the written plan could not say which shortage window a
    //      shipment answers.
    //
    // The window was never missing: the source line CARRIES it as `l.windowCode`, which is where the window
    // now comes from. The horizon is joined on the ref it is actually keyed by — reconstructed from the
    // fields the WSA line carries — and supplies only the required-by DATE. There is no fallback to the old
    // key: a join that cannot resolve is COUNTED and the line still carries its own window, because silently
    // accepting a wrong key is how this went unnoticed for as long as it did.
    var windowCode = s(l.windowCode);
    var ref = [s(l.company), s(l.country), s(l.marketplace), s(l.masterSku), s(l.destinationWarehouseId)].join('|');
    var hz = horizons[ref] || null;
    if (hz) diag.horizon_join_hits++;
    else {
      diag.horizon_join_misses++;
      if (diag.horizon_miss_sample.length < 5) diag.horizon_miss_sample.push({ demand_ref: ref, sku: s(l.masterSku) });
    }
    var requiredBy = '';
    if (hz && hz.requiredByByWindow && windowCode && hz.requiredByByWindow[windowCode] != null) {
      requiredBy = String(hz.requiredByByWindow[windowCode]);
    }
    if (!windowCode) diag.window_blank++;
    // CANONICAL destination classification (concrete active warehouse | logical marketplace | BLOCK).
    var destination = weeklyAiPlanClassifyDestination_(l, whById);
    // §4 — the destination side, named. A FACTORY can never be a replenishment destination, and a factory
    // arriving here means the direction has been inverted somewhere upstream: refuse rather than route it.
    if (destination.kind === 'WAREHOUSE') {
      var dRole = weeklyAiPlanWarehouseRole_(destination.warehouse_id, whById, factoryIdentity);
      diag.destination_roles[dRole.role || '(unresolved)'] = (diag.destination_roles[dRole.role || '(unresolved)'] || 0) + 1;
      if (dRole.role === 'FACTORY') {
        destination = { kind: '', reason: 'DESTINATION_IS_A_FACTORY_WAREHOUSE' };
      }
    } else {
      diag.destination_roles[destination.kind || '(unresolved)'] = (diag.destination_roles[destination.kind || '(unresolved)'] || 0) + 1;
    }
    // ============================================================================================================
    // §4/§8 — ONE ALLOCATED LINE PER SOURCE. The allocator decided the split; this carries it.
    // ============================================================================================================
    var srcId = s(l.sourceWarehouseId);
    var parts;
    if (srcId) {
      parts = [{ warehouse_id: srcId, qty: qty, cartons: null, allocated_qty: qty }];
    } else {
      var sp = weeklyAiPlanSplitBySource_(l, qty, l.unitsPerCarton);
      if (sp.ok) { parts = sp.parts; diag.split_lines++; diag.split_parts += sp.parts.length; }
      else {
        // The truthful refusal is KEPT for the cases that really are unresolvable — a breakdown with no
        // concrete source at all, or a quantity below one carton — and it now says WHICH.
        diag.split_refused.push({ sku: s(l.masterSku), window_code: windowCode, reason: sp.reason });
        out.push({
          sku: s(l.masterSku), site_sku: s(l.siteSku || l.site_sku), window_code: windowCode,
          window_start_date: '', window_end_date: '', required_by_date: requiredBy,
          source_warehouse_id: '', source_warehouse_code_snapshot: '',
          source_multi_pool: true, source_split_refused_reason: sp.reason,
          planned_qty: qty, recommended_qty: qty, units_per_carton: (l.unitsPerCarton != null ? l.unitsPerCarton : ''),
          marketplace: s(l.marketplace), destination: destination
        });
        diag.emitted_lines++;
        return;
      }
    }
    parts.forEach(function (p) {
      var srcWh = whById[p.warehouse_id] || {};
      var role = weeklyAiPlanWarehouseRole_(p.warehouse_id, whById, factoryIdentity);
      diag.source_roles[role.role || '(unresolved)'] = (diag.source_roles[role.role || '(unresolved)'] || 0) + 1;
      out.push({
        sku: s(l.masterSku), site_sku: s(l.siteSku || l.site_sku), window_code: windowCode,
        window_start_date: '', window_end_date: '', required_by_date: requiredBy,
        source_warehouse_id: p.warehouse_id, source_warehouse_code_snapshot: s(srcWh.warehouse_code),
        source_multi_pool: false,
        source_role: role.role, source_role_reason: role.reason || null,
        source_allocated_qty: p.allocated_qty, source_cartons: p.cartons,
        planned_qty: p.qty, recommended_qty: p.qty, units_per_carton: (l.unitsPerCarton != null ? l.unitsPerCarton : ''),
        marketplace: s(l.marketplace), destination: destination
      });
      diag.emitted_lines++;
    });
  });
  // Carried as a property of the returned array so every existing caller (.length / .filter / .forEach) is
  // unaffected and JSON.stringify of the lines is unchanged.
  out.diagnostics = diag;
  return out;
}
function weeklyAiPlanParseResp_(resp) { try { return JSON.parse(resp && resp.getContent ? resp.getContent() : (typeof resp === 'string' ? resp : '{}')); } catch (e) { return { success: false, parse_error: true }; } }

// F1-7N-FA-3C-R6F2G (C) / R6F2G2 (B,C) — authoritative GAP-INV run lineage for a K2 CREATE/REGENERATE. Reads the SAME
// production authority the gap job writes (the GAP_JOB_INVENTORY script property; 46_ gap-materialization job), never a
// fresh clock or a fabricated value. A K2 header MUST stamp calculation_run_id from a DONE GAP-INV run whose planning
// cycle equals the request; a MONTHLY_ORDER run is NEVER used; a missing / non-DONE / wrong-prefix / wrong-cycle run
// BLOCKS before ANY write (zero rows).
// R6F2G2 SEMANTIC FREEZE — two DISTINCT concepts, both from the SAME GAP run but different fields:
//   calculated_at     = st.finishedAt — the wall-clock TIMESTAMP the GAP calculation FINISHED (completion).
//   source_data_as_of = st.calculationDate — the GAP run's FROZEN calculation/input cutoff DATE (server Taipei calendar
//                       date resolved at run execution, NOT a browser clock, NOT current time; 43_:27,251,255). This is
//                       the business-data cutoff the calc consumed. It is persisted on the run and reproducible across
//                       reads without rerunning GAP. It is deliberately NOT the harvest's sourceDataAsOf (which is
//                       sourced from the recommendation-workspace line and is blank for scopes whose lines omit it).
// A blank cutoff BLOCKS before write (never a silent blank, never current time).
function weeklyAiPlanResolveGapRunLineage_(planningCycle, harvest, request) {
  var raw = null;
  try { raw = PropertiesService.getScriptProperties().getProperty('GAP_JOB_INVENTORY'); } catch (e0) { raw = null; }
  if (!raw) return { ok: false, reason: 'LINEAGE_GAP_RUN_UNRESOLVED' };
  var st = null; try { st = JSON.parse(raw); } catch (ep) { st = null; }
  if (!st) return { ok: false, reason: 'LINEAGE_GAP_RUN_UNPARSEABLE' };
  if (String(st.product || '').toUpperCase() !== 'INVENTORY') return { ok: false, reason: 'LINEAGE_RUN_NOT_INVENTORY' };   // MONTHLY_ORDER etc. never used
  var runId = String(st.runId || '').trim();
  if (!/^GAP-INV-/.test(runId)) return { ok: false, reason: 'LINEAGE_RUN_ID_PREFIX_INVALID' };
  if (String(st.status || '').toUpperCase() !== 'DONE') return { ok: false, reason: 'LINEAGE_GAP_RUN_NOT_DONE' };
  var cyc = String(planningCycle || '').trim();
  if (cyc && String(st.planningCycle || '').trim() !== cyc) return { ok: false, reason: 'LINEAGE_RUN_CYCLE_MISMATCH' };
  var sourceDataAsOf = String(st.calculationDate || '').trim();   // R6F2G2: the frozen input cutoff DATE for THIS run
  if (!sourceDataAsOf) return { ok: false, reason: 'LINEAGE_SOURCE_DATA_AS_OF_UNAVAILABLE' };   // block, never silent blank
  return {
    ok: true, run_id: runId,
    calculation_run_id: runId,
    calculated_at: String(st.finishedAt || '').trim(),
    source_data_as_of: sourceDataAsOf,
    formula_version: String((request && request.formulaVersion) || 'WEEKLY_AI_PLAN_V1').trim(),
    planning_cycle: String(st.planningCycle || '').trim()
  };
}

/**
 * R6-R7-R1 §C — the no-action decision as the K2 path sees it. The harvest resolved it; this reads it back
 * rather than recomputing, so the generation and any diagnostic asking the same question get the same answer
 * from the same evaluation. A harvest that predates this round (a half-synced project) carries none, and that
 * is reported as its own reason rather than defaulted to either verdict.
 */
function weeklyAiPlanK2NoAction_(harvest) {
  var d = harvest && harvest.noActionDecision;
  if (!d) return { noAction: false, reason: 'NO_ACTION_AUTHORITY_UNAVAILABLE', recommendation_state: null,
    recommended_qty: null, qualifying_planned_qty: null, residual_qty: null, per_scope: [] };
  return d;
}

function weeklyAiPlanGenerateK2_(ss, request, harvest, deps, body, controlledAuth) {
  var src = KMWRB.buildWeeklySourceLines(request);
  if (!src.ok) return jsonResponse_({ success: false, errors: [weeklyAiPlanErr_(src.status || 'BLOCKED_INPUT', src.reason || 'source lines blocked')] });
  var carriers = weeklyAiPlanReadCarrierAuthorities_(ss);
  var shipDate = weeklyAiPlanShipDate_(harvest);
  var scope0 = request.businessScope || {};
  var allocated = weeklyAiPlanK2AllocatedLines_(src.lines, harvest);
  // group by marketplace (each K2 group is within one marketplace); route dims further split within.
  var byMkt = {};
  allocated.forEach(function (a) { var m = String(a.marketplace || '').trim(); (byMkt[m] = byMkt[m] || []).push(a); });
  // F1-7N-FA-3C-R6F2D (F) — EXACT marketplace scoping for a controlled run. When the request names a marketplace, the
  // run generates ONLY that marketplace (never fans out / never ALL_SITES); the applied scope MUST equal the requested
  // scope or the run fails closed (no out-of-scope rows). An aggregated company/country run (no marketplace) keeps the
  // legacy fan-out but is NOT the controlled-run path.
  var requestedMkt = String(scope0.marketplace != null ? scope0.marketplace : '').trim();
  // R6-R7-R1 §C — an aggregated run whose whole universe allocated nothing asks the same question. It is
  // the identical situation without a marketplace to name, and answering it differently would make the
  // correctness of the answer depend on how the request was addressed.
  if (!allocated.length) {
    var _naAll = weeklyAiPlanK2NoAction_(harvest);
    if (_naAll.noAction) {
      return jsonResponse_(weeklyAiPlanNoActionResponse_(_naAll, {
        planning_cycle: request.planningCycle, scope: scope0, mode: request.mode || null,
        site_count: harvest.site_count == null ? null : harvest.site_count,
        source_data_as_of: weeklyAiPlanStr_(harvest.sourceDataAsOf) || null,
        recommendation_authority: harvest.recommendationState || null }));
    }
  }
  if (requestedMkt) {
    if (/^all(_sites)?$/i.test(requestedMkt)) return jsonResponse_({ success: false, errors: [weeklyAiPlanErr_('SCOPE_ALL_SITES_FORBIDDEN', 'a controlled run must target exactly one marketplace, never ALL_SITES')] });
    if (!byMkt[requestedMkt]) {
      // R6-R7-R1 §C — BEFORE THIS IS REPORTED AS A FAILURE, ASK WHETHER IT IS ONE.
      //
      // 'produced no allocated lines' was the same sentence for 'this SKU needs nothing today' and 'you
      // asked for a scope that is not there'. The first is a correct finish and the second is a fault, and
      // an operator told the second about the first has no way to discover the truth. The canonical row
      // decides, because it is the only thing that can: a READY row with a finite number in every window
      // is a STATEMENT, and an absent, BLOCKED, duplicated or half-written one is not.
      var _na = weeklyAiPlanK2NoAction_(harvest);
      if (_na.noAction) {
        return jsonResponse_(weeklyAiPlanNoActionResponse_(_na, {
          planning_cycle: request.planningCycle, scope: scope0, mode: request.mode || null,
          site_count: harvest.site_count == null ? null : harvest.site_count,
          source_data_as_of: weeklyAiPlanStr_(harvest.sourceDataAsOf) || null,
          recommendation_authority: harvest.recommendationState || null }));
      }
      // Still a refusal — and it now says WHY it could not be read as a zero, so the two are never
      // confused again by anyone reading this response.
      //
      // R6-R7-R2: built by the SHARED builder, which is also where a preflight reads this code from. A
      // diagnostic that spelled 'REQUESTED_SCOPE_EMPTY' itself would keep reporting it after this line
      // changed, and nothing would notice.
      return jsonResponse_(weeklyAiPlanScopeEmptyRefusal_(_na, {
        requested_marketplace: requestedMkt,
        recommendation_authority: harvest.recommendationState || null }));
    }
    var only = {}; only[requestedMkt] = byMkt[requestedMkt]; byMkt = only;   // fail-closed: never generate outside the frozen marketplace
  }
  // F1-7N-FA-3C-R6F2F1 — IMMEDIATE BACKEND GATE. Generation proceeds ONLY when the GLOBAL flag is true (normal
  // production) OR an INTERNAL controlled capability authorizes THIS exact scope while the flag is false. Every other
  // flag-false invocation is blocked with a typed CONTROLLED_GENERATION_UNAUTHORIZED (zero writes). The public handler
  // gates the flag BEFORE reaching here, and never passes controlledAuth — so no public/frontend request can pass.
  var flagTrue = (typeof inventoryAiPlanDbGenerationEnabled_ === 'function') && inventoryAiPlanDbGenerationEnabled_() === true;
  // F1-7N-FC-1B-E3-R4-A2-R1 §9 — THE FLAG SAYS "GENERATION IS ON". IT DOES NOT SAY "FOR EVERYTHING".
  //
  // The global flag is the only switch this path had, and it is far too blunt to turn on for a trial: flipping
  // it authorizes materialization for every company, country, marketplace and SKU at once, so the first
  // controlled run and a 495-scope production write are the same gesture. The allowlist splits those apart.
  // It is SERVER-OWNED config beside the flag itself, so no request payload and no browser can widen it, and
  // widening it is a deployment with a diff.
  //
  // IT GATES AT THE WRITER, not at the harvest. A census, a dry run and a readiness report must still be able
  // to SEE every scope — refusing to look is not safety, it is blindness. What must be narrow is what gets
  // WRITTEN, and this is the last point before that.
  //
  // Lines outside the allowlist are DROPPED and COUNTED, never silently included and never silently ignored:
  // if nothing survives, the run refuses with a typed code rather than reporting a successful plan for zero
  // routes, because those two mean opposite things to whoever pressed the button.
  if (flagTrue) {
    var _gateOn = (typeof inventoryAiPlanScopeEnabled_ === 'function');
    if (!_gateOn) {
      return jsonResponse_({ success: false, errors: [weeklyAiPlanErr_('AI_PLAN_SCOPE_GUARD_UNAVAILABLE',
        'the activation allowlist is not present in this deployment; generation is refused rather than run unguarded')] });
    }
    var _kept = {}, _keptCount = 0, _excluded = [];
    for (var _mk in byMkt) {
      if (!Object.prototype.hasOwnProperty.call(byMkt, _mk)) continue;
      var _in = byMkt[_mk].filter(function (a) {
        var okScope = inventoryAiPlanScopeEnabled_(scope0.company, scope0.country, _mk, a && a.sku);
        if (!okScope) _excluded.push({ marketplace: _mk, sku: weeklyAiPlanStr_(a && a.sku) });
        return okScope;
      });
      if (_in.length) { _kept[_mk] = _in; _keptCount += _in.length; }
    }
    if (!_keptCount) {
      return jsonResponse_({ success: false, errors: [weeklyAiPlanErr_('AI_PLAN_SCOPE_NOT_ENABLED',
        'no line in this run is inside the controlled activation allowlist; zero rows written',
        { scope: { company: scope0.company, country: scope0.country, marketplace: requestedMkt || null },
          excluded_count: _excluded.length, excluded_sample: _excluded.slice(0, 10),
          allowlist: (typeof inventoryAiPlanActivationAllowlist_ === 'function') ? inventoryAiPlanActivationAllowlist_() : null,
          db_writes: 0 })] });
    }
    byMkt = _kept;
    // Carried out with the result so a partial run is visible rather than inferred from a smaller number.
    harvest = harvest || {};
    harvest.scope_guard = { enforced: true, kept_lines: _keptCount, excluded_lines: _excluded.length,
      excluded_sample: _excluded.slice(0, 10) };
  }
  if (!flagTrue) {
    var liveScopeSpec = { scope: { company: scope0.company, country: scope0.country, marketplace: requestedMkt }, planning_cycle: request.planningCycle };
    var authRes = (typeof WeeklyAiPlanControlledAuthority_ !== 'undefined') ? WeeklyAiPlanControlledAuthority_.verify(controlledAuth, liveScopeSpec) : { ok: false, reason: 'AUTHORITY_MODULE_MISSING' };
    if (!authRes.ok) return jsonResponse_({ success: false, disabled: true, errors: [weeklyAiPlanErr_('CONTROLLED_GENERATION_UNAUTHORIZED', 'global flag is false and no valid INTERNAL controlled authority for this exact scope (' + authRes.reason + '); zero rows written', { auth_reason: authRes.reason })] });
  }
  // F1-7N-FA-3C-R6F2G (C) — resolve + BLOCK on the authoritative GAP-INV run lineage BEFORE any write. A K2 header must
  // carry the DONE GAP-INV run id (cycle-matched) as calculation_run_id; without it the run fails closed (zero rows).
  var lineage = weeklyAiPlanResolveGapRunLineage_(request.planningCycle, harvest, request);
  if (!lineage.ok) return jsonResponse_({ success: false, errors: [weeklyAiPlanErr_(lineage.reason, 'K2 generation blocked: authoritative GAP-INV run lineage unavailable or mismatched (' + lineage.reason + '); zero rows written', { planning_cycle: request.planningCycle })] });
  // F1-7N-FC-1B-E3-R4-A2-R1-R3 §6 — ONE RUN, OR NEITHER. The harvest resolved the ship-date cutoff from the
  // GAP-INV run lineage and the header stamps its calculation_run_id from the same authority. Those are two
  // reads of one script property and they can only differ if the job advanced mid-generation — in which case
  // the plan would be dated by one run and attributed to another. That is a refusal, not something to prefer
  // a side of.
  var _hAuth = (harvest && harvest.sourceDataAsOfAuthority) || null;
  if (_hAuth && weeklyAiPlanStr_(_hAuth.run_id) && weeklyAiPlanStr_(_hAuth.run_id) !== weeklyAiPlanStr_(lineage.calculation_run_id)) {
    return jsonResponse_({ success: false, zero_write: true,
      errors: [weeklyAiPlanErr_('GAP_RUN_LINEAGE_MOVED_MID_GENERATION',
        'the GAP-INV run that dated this harvest is not the run the header would be stamped with; zero rows written',
        { harvest_run_id: _hAuth.run_id, writer_run_id: lineage.calculation_run_id,
          harvest_source_data_as_of: _hAuth.date, writer_source_data_as_of: lineage.source_data_as_of, db_writes: 0 })] });
  }

  var groupsWritten = [], blockedTotal = [], conservationAll = [], anyOk = false, anyFail = false;

  // DELIBERATELY PLACED AFTER THE AUTHORIZATION GATE REGION. The gate above authorizes ONLY from the internal
  // controlled capability via verify(); a standing regression test asserts that region reads NO `body.` field,
  // because anything it reads from the request is something a caller could try to authorize itself with. The run
  // id is identity, not authorization — but it does read the body, so it belongs outside that region rather than
  // weakening the invariant that protects it.
  // F1-7N-FB-4C §E Stage 1 — THE IMMUTABLE GENERATION RUN ID. Minted ONCE, before any write, and stamped on
  // every header this run touches. It is what makes "rows of an OLDER run" a decidable question later, and what
  // makes a retry idempotent: the caller's execution key derives the same id, so a repeat run REUSEs its own
  // committed rows instead of creating a second current run.
  var executionKey = weeklyAiPlanStr_(body && (body.execution_key || body.executionKey)) ||
    ('AIPLAN-' + sadFnv1a_([request.planningCycle, scope0.company, scope0.country, requestedMkt, lineage.calculation_run_id].join('|')).toUpperCase());
  var generationRunId = 'AIRUN-' + sadFnv1a_(executionKey).toUpperCase();

  // ==========================================================================================================
  // ADDENDUM §A/§B — TWO PASSES, WITH THE GATE BETWEEN THEM.
  //
  // FB-4C built each marketplace's plan and wrote it in the SAME loop, so the first row was committed before
  // anything had looked at the lifecycle schema or at what the operator had already decided. The plan builder
  // (KMWRR.buildK2GenerationPlan) is pure, so the loop splits cleanly: PASS 1 computes every group and writes
  // nothing; the gate then runs on the complete set of proposed identities; PASS 2 writes only what survived.
  // This is what makes "zero writes" a structural property rather than a claim - there is no code path from a
  // gate refusal to a write.
  // ==========================================================================================================

  // ---- PASS 1: compute every group. ZERO WRITES. ----
  var planned = [];                                  // { marketplace, groupNo, header, lines, identity_key }
  Object.keys(byMkt).sort().forEach(function (M) {
    var plan = KMWRR.buildK2GenerationPlan({
      scope: { planning_cycle: request.planningCycle, company: scope0.company, country: scope0.country, marketplace: M, source_page: scope0.source_page },
      allocatedLines: byMkt[M], warehousesById: harvest.warehousesById,
      rateCards: carriers.rateCards, leadTimes: carriers.leadTimes, shipDate: shipDate,
      authorizedBySkuWindow: (function () { var a = {}; byMkt[M].forEach(function (x) { var k = String(x.sku).toLowerCase() + '|' + String(x.window_code).toLowerCase(); a[k] = (a[k] || 0) + (Number(x.planned_qty) || 0); }); return a; })(),
      sourceCeilingById: {}
    });
    // §4 — the generation's own report dropped the sub-type too. `block: b.block` alone is the bare token
    // the live log showed, and it is the half an operator cannot act on: ROUTE_METHOD_UNRESOLVED names a
    // symptom, NO_CARRIER_CARD_FOR_LANE names the table and the row to add.
    plan.blocked.forEach(function (b) {
      blockedTotal.push({ marketplace: M, block: b.block,
        reason: b.method_unresolved_reason || b.auto_ranking_insufficient_reason || null,
        lane_query: b.lane_query || null,
        quantity: (b.line && (b.line.planned_qty != null ? b.line.planned_qty : b.line.recommended_qty)) || 0 });
    });
    // §4 — supply-allocation safety and route COMPLETENESS are recorded as the different things they are.
    // `conserved` alone let a run report a conserved plan that had routed none of the demand.
    // §9 (R5) — and the per-scope ADVICE beside them, so a batch can report which scope carries which
    // warning instead of collapsing every scope into one outcome.
    var _advice = (typeof weeklyAiPlanMethodAdvice_ === 'function')
      ? weeklyAiPlanMethodAdvice_(byMkt[M], harvest, carriers.leadTimes, shipDate) : null;
    var _status = (typeof weeklyAiPlanAdviceStatus_ === 'function')
      ? weeklyAiPlanAdviceStatus_({ shared_blockers: [], completeness: plan.completeness || null,
          method_advice: _advice,
          carrier_pricing_ready: (function () {
            // Layer 2 readiness for THIS scope: does any usable rate card cover any of its lanes?
            if (typeof weeklyAiPlanCarrierReadiness_ !== 'function' || !KMWRR || typeof KMWRR.dateToOrdinal !== 'function') return false;
            var asOf = KMWRR.dateToOrdinal(shipDate), any = false, seen = {};
            (byMkt[M] || []).forEach(function (a) {
              var w = (harvest.warehousesById || {})[weeklyAiPlanStr_(a.source_warehouse_id)] || null;
              var d = a.destination || {};
              var q = { originCountry: weeklyAiPlanStr_(w && w.country), destinationCountry: weeklyAiPlanStr_(d.country),
                marketplace: weeklyAiPlanStr_(d.marketplace) };
              var k = q.originCountry + '|' + q.destinationCountry + '|' + q.marketplace;
              if (seen[k]) return; seen[k] = 1;
              var r = weeklyAiPlanCarrierReadiness_(carriers.rateCards, carriers.leadTimes, q, asOf);
              if (r.rate_card && r.rate_card.usable_on_lane > 0) any = true;
            });
            return any;
          })() })
      : null;
    conservationAll.push({ marketplace: M, conserved: plan.conservation.conserved,
      completeness: plan.completeness || null, method_advice: _advice, layered_status: _status });
    plan.groups.forEach(function (g) {
      // R6F2G (C) — stamp the authoritative lineage onto the header before the atomic write. These fields are EXCLUDED
      // from the REUSE fingerprint (SAD_K2_HEADER_FP_/LINE_FP_), so a committed group still REUSEs (zero writes) here.
      g.header.calculation_run_id = lineage.calculation_run_id;
      g.header.formula_version = lineage.formula_version;
      g.header.calculated_at = lineage.calculated_at;
      g.header.source_data_as_of = lineage.source_data_as_of;
      // FB-4C §D — provenance for the lifecycle. `generation_run_id` marks WHICH run owns this row; without it
      // no later run can tell its own rows from the ones it is replacing.
      g.header.generation_run_id = generationRunId;
      // F1-7N-FC-1B-E3-R4-A2-R1-R2 §5 — AND THE PROVENANCE MARKER ITSELF, which was never set.
      //
      // The atomic writer defaults generation_type to `user_created`, so every AI row was STORED with a manual
      // marker. aiplIsAiGenerated_ reads `user_created` and returns false before it ever looks at the run id,
      // so the next generation read its own output back as a binding operator decision and suppressed itself
      // (ALL_SUPPRESSED_BY_MANUAL). The route intent was only half the reason a replay went wrong; this is the
      // other half, and it would have mislabelled every AI row even with the intent fixed.
      g.header.generation_type = 'system_generated';
      planned.push({
        marketplace: M, groupNo: g.groupNo, header: g.header, lines: g.lines,
        identity_key: (typeof sadK2GroupKey_ === 'function') ? sadK2GroupKey_(g.header) : '',
        recommended_total: (g.lines || []).reduce(function (a, l) { return a + (Number(l.recommended_qty) || 0); }, 0)
      });
    });
  });

  // ---- THE GATE. Reads only. Anything that fails here returns BEFORE the first write. ----
  var activeRows = [], activeHeaders = [];
  try {
    var _hs = ss.getSheetByName('shipping_allocation_drafts');
    if (_hs) {
      var _d = _hs.getDataRange().getValues();
      if (_d && _d.length > 1) {
        activeHeaders = _d[0].map(function (h) { return String(h == null ? '' : h).trim(); });
        for (var _r = 1; _r < _d.length; _r++) {
          var _o = { __row: _r + 1 };
          for (var _c = 0; _c < activeHeaders.length; _c++) if (activeHeaders[_c]) _o[activeHeaders[_c]] = _d[_r][_c];
          var _st = String(_o.status == null ? '' : _o.status).trim().toLowerCase();
          // "Active" = not terminal. The named terminal set is the authority; an expired/submitted/cancelled row
          // holds no identity and must never suppress a fresh recommendation.
          var _term = (typeof SAD_TERMINAL_STATUSES_ !== 'undefined') ? SAD_TERMINAL_STATUSES_ : { submitted: 1, cancelled: 1, expired: 1 };
          if (!_term[_st]) activeRows.push(_o);
        }
      }
    }
  } catch (eRead) { activeRows = []; }

  // §B — per-identity precedence, computed on the FULL proposed set before anything is written.
  var precedence = (typeof aiplManualPrecedence_ === 'function')
    ? aiplManualPrecedence_(activeRows, planned.map(function (pl) {
        var held = null;
        for (var i = 0; i < activeRows.length; i++) {
          if ((typeof sadK2GroupKey_ === 'function' ? sadK2GroupKey_(activeRows[i]) : '') === pl.identity_key) { held = activeRows[i]; break; }
        }
        return { identity_key: pl.identity_key, recommendation: pl.recommended_total,
                 persisted_user_qty: held ? (held.__persisted_user_qty != null ? held.__persisted_user_qty : null) : null };
      }), function (r) { return (typeof sadK2GroupKey_ === 'function') ? sadK2GroupKey_(r) : ''; })
    : planned.map(function (pl) { return { identity_key: pl.identity_key, decision: 'PROCEED' }; });

  var decisionByKey = {};
  precedence.forEach(function (d) { decisionByKey[d.identity_key] = d; });
  var collisions = precedence.filter(function (d) { return d.decision === 'ACTIVE_SOURCE_IDENTITY_COLLISION'; });
  var suppressed = precedence.filter(function (d) { return d.decision === 'SUPPRESSED_BY_ACTIVE_MANUAL_DRAFT'; });

  // §A/§H — the schema/activation gate. Placed HERE: after the run id is minted (the gate requires one) and
  // before the first write. On refusal the whole command stops with zero writes and the complete diagnosis.
  if (typeof aiplActivationGate_ === 'function' && typeof aiplReadActivationFacts_ === 'function') {
    var facts = aiplReadActivationFacts_(ss, { generation_run_id: generationRunId, identity_collisions: collisions });
    var gate = aiplActivationGate_(facts);
    if (!gate.ready) {
      return jsonResponse_({
        success: false, zero_write: true,
        errors: [gate.error],
        data: {
          mode: 'K2_ROUTE_GROUP', job_status: 'BLOCKED_SCHEMA_NOT_READY',
          planningCycle: request.planningCycle, businessScope: scope0,
          generation_run_id: generationRunId, execution_key: executionKey,
          created_headers: 0, updated_headers: 0, created_lines: 0, updated_lines: 0,
          expired_headers: 0, expired_lines: 0, active_count: 0, expired_count: 0,
          zero_result: false, groups: [], blocked: [],
          lifecycle: { ran: false, reason: gate.error.code, expired_headers: 0, expired_lines: 0 },
          schema_gate: gate.error
        }
      });
    }
  } else {
    // The lifecycle module is not in the deployed project. That is a MIXED DEPLOYMENT, not a reason to proceed:
    // without it nothing would expire and the run would leave two active plans - exactly the state §A forbids.
    return jsonResponse_({
      success: false, zero_write: true,
      errors: [weeklyAiPlanErr_('AI_PLAN_LIFECYCLE_SCHEMA_NOT_READY',
        'the AI Plan lifecycle module (69_api_v1_ai_plan_lifecycle.gs) is not present in this Apps Script project, so no run may write: it would create a new draft while leaving the previous one active.',
        { missing_table: [], missing_columns: [], invalid_status_authority: [],
          expected_migration_version: 'FB4C-AI-LIFECYCLE-1', zero_write: true,
          created_headers: 0, created_lines: 0, expired_headers: 0, expired_lines: 0,
          next_action: 'Sync 69_api_v1_ai_plan_lifecycle.gs into the Apps Script project and publish a new deployment version.' })],
      data: { job_status: 'BLOCKED_LIFECYCLE_MODULE_MISSING', created_headers: 0, created_lines: 0, expired_headers: 0, expired_lines: 0, groups: [] }
    });
  }

  // ---- PASS 2: write. Only identities the gate and precedence allow. ----
  planned.forEach(function (pl) {
    var d = decisionByKey[pl.identity_key] || { decision: 'PROCEED' };
    // §B — an active manual Execution Plan is the binding decision: no parallel AI draft, no overwrite. The run
    // continues for every other identity, and the suppression is REPORTED with what the AI would have proposed.
    if (d.decision === 'SUPPRESSED_BY_ACTIVE_MANUAL_DRAFT' || d.decision === 'ACTIVE_SOURCE_IDENTITY_COLLISION') {
      groupsWritten.push({
        marketplace: pl.marketplace, groupNo: pl.groupNo, outcome: d.decision,
        allocation_draft_id: (d.manual_identity && d.manual_identity.allocation_draft_id) || null,
        draft_version: null, line_count: 0, ok: true, suppressed: true,
        created: false, updated: false, blocks_run: false,
        identity_key: pl.identity_key, precedence: d, error: null
      });
      return;
    }
    // G — each K2 group is INDIVIDUALLY atomic (one lock inside the atomic endpoint). The overall job reports a
    // truthful per-group outcome; whole-job success is claimed ONLY when every group committed. A retry uses the
    // SAME deterministic identity (SADH-K2-…) so a committed group REUSEs (zero writes), never duplicates.
    // F1-7N-FC-1B-E3-R4-A2-R1-R2 §2 — THE GENERATION DECLARES WHAT IT IS DOING.
    //
    // A2-R3 made every route write declare its intent, and this call site never did, so from that round
    // onward EVERY generation refused with ROUTE_INTENT_REQUIRED and wrote nothing. It is not an oversight
    // that can be fixed by picking one of the two existing intents: this is a create-or-reconcile against a
    // DETERMINISTIC K2 identity, which is neither minting a ticket nor editing one named by id. The execution
    // key travels with it as the second witness to a replay, beside the K2 identity itself.
    var resp = weeklyAiPlanParseResp_(handleUpsertShippingAllocationDraftAtomic_({
      header: pl.header, lines: pl.lines, enforce_k2_grouping: true,
      intent: 'UPSERT_AI_GENERATED_K2_ROUTE', execution_key: executionKey }));
    var dd = (resp && resp.data) ? resp.data : {};
    var outcome = resp && resp.success ? (resp.reused ? 'REUSED' : (dd.outcome || 'CREATED')) : ((dd && dd.reason) ? dd.reason : (resp && /COMMITTED_UNVERIFIED/.test(resp.error || '') ? 'COMMITTED_UNVERIFIED' : (resp && /RECONCILIATION_REQUIRED/.test(resp.error || '') ? 'RECONCILIATION_REQUIRED' : 'BLOCKED')));
    if (resp && resp.success) anyOk = true; else anyFail = true;
    groupsWritten.push({ marketplace: pl.marketplace, groupNo: pl.groupNo, outcome: outcome, allocation_draft_id: dd.allocation_draft_id || null, draft_version: dd.draft_version || null, line_count: dd.line_count || 0, ok: !!(resp && resp.success), identity_key: pl.identity_key, error: (resp && !resp.success) ? resp.error : null });
  });

  var outcomeCounts = {};
  groupsWritten.forEach(function (g) { outcomeCounts[g.outcome] = (outcomeCounts[g.outcome] || 0) + 1; });
  // F1-7N-FA-3C-R6F2D (F) — applied scope MUST equal the requested scope. The applied marketplaces = the ones actually
  // generated; on a controlled (marketplace-scoped) run this must be exactly the requested marketplace (no widening).
  var appliedMkts = {}; groupsWritten.forEach(function (g) { appliedMkts[String(g.marketplace || '')] = 1; }); blockedTotal.forEach(function (b) { appliedMkts[String(b.marketplace || '')] = 1; });
  var appliedList = Object.keys(appliedMkts).filter(function (m) { return m !== ''; }).sort();
  var scopeEqual = requestedMkt ? (appliedList.length <= 1 && (appliedList.length === 0 || appliedList[0] === requestedMkt)) : true;
  if (requestedMkt && !scopeEqual) return jsonResponse_({ success: false, errors: [weeklyAiPlanErr_('APPLIED_SCOPE_WIDENED', 'applied scope ' + JSON.stringify(appliedList) + ' != requested marketplace ' + requestedMkt + ' — refused (no out-of-scope rows)')] });
  // job-level status: COMPLETED only if every group ok; else PARTIAL (never claim whole-job success on partial commit).
  // ADDENDUM §B — a SUPPRESSED group is neither a success nor a failure of this run: the operator already
  // decided that identity, so it contributes no write and must not turn a clean run into PARTIAL. A run whose
  // every group was suppressed still succeeded - it correctly wrote nothing.
  var writtenGroups = groupsWritten.filter(function (g) { return !g.suppressed; });
  var jobStatus = writtenGroups.length === 0
    ? (blockedTotal.length ? 'ALL_BLOCKED' : (groupsWritten.length ? 'ALL_SUPPRESSED_BY_MANUAL' : 'NO_DEMAND'))
    : (anyFail ? (anyOk ? 'PARTIAL' : 'FAILED') : 'COMPLETED');

  // F1-7N-FB-4C §E — A ZERO-RESULT RUN IS A SUCCESSFUL RUN. Computing no recommendations is a real answer about
  // the world ("nothing needs shipping this cycle"), not a failure, and it must still replace the previous
  // proposal — otherwise last week's plan silently stays active and looks like this week's advice. It writes NO
  // empty header and NO empty line. ALL_BLOCKED is NOT this case: something went wrong there, so nothing expires.
  var zeroResult = (jobStatus === 'NO_DEMAND');
  // ALL_SUPPRESSED_BY_MANUAL is a SUCCESSFUL run with nothing to write: every identity it would have proposed is
  // already held by a binding operator decision. It still supersedes older AI drafts of the same scope, because
  // "the operator has this covered" is as real an answer about the world as a fresh recommendation.
  var allSuppressed = (jobStatus === 'ALL_SUPPRESSED_BY_MANUAL');
  var runSucceeded = zeroResult || allSuppressed || (anyOk && !anyFail);

  // ==============================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R5 §9 — A BATCH NEEDS THREE OUTCOMES, NOT TWO.
  //
  // With only SUCCESS and STOP, any scope that could not be fully routed dragged the whole batch down, and a
  // Carrier gap on ONE lane discarded correct advice for every other scope in the run. That is the same
  // boundary error as R4's, one level up.
  //
  //   SUCCESS                 every scope produced advice and nothing warned
  //   SUCCESS_WITH_WARNINGS   every scope produced advice; at least one carries a warning (missing method
  //                           authority, missing pricing, or a route that could not be materialized)
  //   STOP                    a SHARED/system fault, or a scope whose numbers are untrustworthy
  //
  // Carrier coverage can only ever move a batch into the middle band. It is written here as an explicit list of
  // what MAY stop a batch, so the exclusion is a rule rather than an omission.
  var scopeWarnings = [], scopesWithWarnings = [], scopesReady = 0;
  conservationAll.forEach(function (c) {
    var ls = c.layered_status || null;
    if (ls && ls.recommendation_ready === true) scopesReady++;
    if (ls && ls.warnings && ls.warnings.length) {
      scopesWithWarnings.push(c.marketplace);
      ls.warnings.forEach(function (w) { scopeWarnings.push({ marketplace: c.marketplace, warning: w }); });
    }
  });
  // The ONLY faults that may stop a batch. A missing rate card and a missing lead time are deliberately absent.
  var batchStopReasons = [];
  if (anyFail && !anyOk) batchStopReasons.push('EVERY_SCOPE_FAILED_TO_COMMIT');
  conservationAll.forEach(function (c) {
    if (c.conserved !== true) batchStopReasons.push('QUANTITY_CONSERVATION_FAILED:' + c.marketplace);
  });
  var batchVerdict = batchStopReasons.length ? 'STOP'
    : (scopeWarnings.length ? 'SUCCESS_WITH_WARNINGS' : 'SUCCESS');
  var batchReport = {
    contract: 'F1-7N-FC-1B-E3-R4-A2-R1-R5 §9 — Carrier coverage may move a batch to SUCCESS_WITH_WARNINGS and '
      + 'may NEVER move it to STOP; one scope\'s gap never blocks another scope',
    verdict: batchVerdict,
    scope_count: conservationAll.length,
    scopes_recommendation_ready: scopesReady,
    scopes_with_warnings: scopesWithWarnings,
    warnings: scopeWarnings,
    stop_reasons: batchStopReasons,
    may_stop_a_batch: ['SNAPSHOT_UNAVAILABLE', 'FORECAST_AUTHORITY_UNRESOLVED', 'SCHEMA_OR_RUNTIME_AUTHORITY_DIVERGENCE',
      'DEMAND_MAPPING_FAILED', 'QUANTITY_CONSERVATION_FAILED', 'EVERY_SCOPE_FAILED_TO_COMMIT'],
    never_stops_a_batch: ['NO_TRANSIT_AUTHORITY_FOR_LANE', 'NO_CARRIER_CARD_FOR_LANE',
      'CARRIER_PRICING_DEFERRED', 'CARRIER_PRICING_UNAVAILABLE', 'ROUTE_METHOD_MANUAL_REVIEW_REQUIRED',
      'MANUAL_ROUTE_SELECTION_REQUIRED', 'MANUAL_CARRIER_SELECTION_REQUIRED',
      'EXECUTION_ROUTE_NOT_MATERIALIZED', 'USER_MASTER_DATA_REQUIRED'],
    // R6 §9 — a warning on one scope may never suppress another scope's result. Stated as a measured fact:
    // how many scopes are ready AND carry a warning. A scope in that set is the exact case R5 and R6 exist to
    // protect, so it is counted rather than left to be inferred.
    scopes_ready_and_warned: (function () {
      var n = 0;
      conservationAll.forEach(function (c) {
        var ls = c.layered_status;
        if (ls && ls.recommendation_ready === true && ls.recommendation_warning_codes
          && ls.recommendation_warning_codes.length) n++;
      });
      return n;
    })()
  };

  // §E Stage 3 steps 5-7 — EXPIRE ONLY AFTER THE CURRENT RUN IS COMMITTED AND VERIFIED. A failed or partial run
  // expires NOTHING, so the operator is never left without an active plan because a replacement half-landed.
  var lifecycle = { attempted: false, ok: null, expired_headers: 0, expired_lines: 0, reason: null, verification: null, manifest: null };
  if (runSucceeded) {
    if (typeof aiplExpireSupersededDrafts_ !== 'function') {
      lifecycle.reason = 'AI_PLAN_LIFECYCLE_MODULE_MISSING';
    } else {
      lifecycle.attempted = true;
      var committedIds = groupsWritten.filter(function (g) { return g.ok && g.allocation_draft_id; })
        .map(function (g) { return String(g.allocation_draft_id); });
      var expScopes = requestedMkt ? [requestedMkt] : appliedList;
      var agg = { ok: true, expired_headers: 0, expired_lines: 0, verification: [], manifest: [], blockers: [] };
      expScopes.forEach(function (M) {
        var r = aiplExpireSupersededDrafts_(ss, {
          scope: { company: scope0.company, country: scope0.country, marketplace: M,
            planning_cycle: request.planningCycle, source_page: WEEKLY_AI_PLAN_SOURCE_PAGE_ },
          generation_run_id: generationRunId, committed_ids: committedIds,
          actor: weeklyAiPlanStr_(body && body.actor) || 'inventory-ai-plan'
        });
        if (!r.ok) agg.ok = false;
        agg.expired_headers += r.expired_headers || 0;
        agg.expired_lines += r.expired_lines || 0;
        if (r.verification) agg.verification.push({ marketplace: M, verification: r.verification });
        if (r.manifest) agg.manifest.push({ marketplace: M, checksum: r.manifest.checksum, expire_count: r.manifest.expire_count, preserve_count: r.manifest.preserve_count });
        if (r.blockers && r.blockers.length) agg.blockers.push({ marketplace: M, blockers: r.blockers });
      });
      lifecycle.ok = agg.ok;
      lifecycle.expired_headers = agg.expired_headers;
      lifecycle.expired_lines = agg.expired_lines;
      lifecycle.verification = agg.verification;
      lifecycle.manifest = agg.manifest;
      if (!agg.ok) lifecycle.reason = agg.blockers.length ? 'EXPIRATION_BLOCKED' : 'EXPIRATION_VERIFICATION_FAILED';
      if (agg.blockers.length) lifecycle.blockers = agg.blockers;
    }
  } else {
    lifecycle.reason = 'RUN_NOT_SUCCESSFUL_NOTHING_EXPIRED';
  }

  // ==============================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R6 §4 — THE ADVICE THE PAGE COULD NOT SEE.
  //
  // The layered status has been computed per scope since R5, and it was reachable only as
  // `data.conservation[i].layered_status` — a per-marketplace diagnostic inside an array the page does not
  // read. So a run that produced a complete recommendation for 760 units, and wrote no route because a person
  // still has to choose a method, arrived in the browser as "0 routes written" and nothing else. The page had
  // no recommendation to show and said the only thing left to say: no eligible route, nothing in the current
  // data supports a shipment here.
  //
  // That sentence is false, and it is false in the direction that costs money — an operator who believes there
  // is nothing to ship does not ship. The advice is lifted to ONE top-level object in the shape a consumer
  // switches on, so "the plan ran and here is what it advises" can no longer arrive looking like "the plan ran
  // and found nothing".
  //
  // `outcome` is the field a UI branches on, and it has THREE values. Two were never enough: a run that
  // advises with warnings is not a plain success, and it is emphatically not a failure.
  // ==============================================================================================================
  var adviceReport = (function () {
    var scopes = [], codes = [], anyReady = false, allReady = conservationAll.length > 0;
    var qty = { authorized: 0, supply_allocated: 0, unresolved_supply: 0,
      automatic_route: 0, manual_route_review: 0, unresolved_route: 0, execution_route_materialized: 0 };
    function add(t, v) { var n = Number(v); if (isFinite(n)) qty[t] += n; }
    conservationAll.forEach(function (c) {
      var ls = c.layered_status || null;
      if (!ls) { allReady = false; return; }
      if (ls.recommendation_ready === true) anyReady = true; else allReady = false;
      (ls.recommendation_warning_codes || []).forEach(function (k) { if (codes.indexOf(k) === -1) codes.push(k); });
      add('authorized', ls.authorized_quantity);
      add('supply_allocated', ls.supply_allocated_quantity);
      add('unresolved_supply', ls.unresolved_supply_quantity);
      add('automatic_route', ls.automatic_route_quantity);
      add('manual_route_review', ls.manual_route_review_quantity);
      add('unresolved_route', ls.unresolved_route_quantity);
      add('execution_route_materialized', ls.execution_route_materialized_quantity);
      scopes.push({ marketplace: c.marketplace,
        recommendation_ready: ls.recommendation_ready === true,
        method_status: ls.method_status,
        carrier_pricing_ready: ls.carrier_pricing_ready === true,
        execution_route_materialized: ls.execution_route_materialized === true,
        submit_ready: ls.submit_ready === true,
        authorized_quantity: ls.authorized_quantity,
        supply_allocated_quantity: ls.supply_allocated_quantity,
        unresolved_supply_quantity: ls.unresolved_supply_quantity,
        automatic_route_quantity: ls.automatic_route_quantity,
        manual_route_review_quantity: ls.manual_route_review_quantity,
        unresolved_route_quantity: ls.unresolved_route_quantity,
        execution_route_materialized_quantity: ls.execution_route_materialized_quantity,
        route_materialization_complete: ls.route_materialization_complete === true,
        // WHERE the units come from, by name, because "760 units" with no source is not advice a person can
        // act on and the page has to be able to print it.
        sources: weeklyAiPlanAdviceSources_(byMkt[c.marketplace] || [], harvest),
        method_advice: c.method_advice || null,
        recommendation_warnings: ls.recommendation_warnings || [],
        recommendation_warning_codes: ls.recommendation_warning_codes || [],
        shared_blockers: ls.shared_blockers || []
      });
    });
    return {
      contract: 'F1-7N-FC-1B-E3-R4-A2-R1-R6 §4 — the AI Plan advice, lifted to the top level so a consumer '
        + 'never has to reconstruct it from a per-marketplace diagnostic array',
      outcome: batchVerdict === 'STOP' ? 'FAILURE'
        : (anyReady ? (codes.length ? 'SUCCESS_WITH_WARNINGS' : 'SUCCESS') : 'FAILURE'),
      recommendation_ready: anyReady,
      all_scopes_recommendation_ready: allReady,
      quantities: qty,
      warning_codes: codes,
      // Said in the data, because the page's job here is to not frighten anybody: a warning means a person has
      // a decision to make. It does not mean the run failed, and it does not mean anything stored was touched.
      warnings_are_not_failures: true,
      // Whether the stored Execution Plan actually moved. A run that advises and writes nothing must be able
      // to say "your plan is untouched" as a FACT rather than as a reassurance.
      execution_plan_changed: (writtenGroups.filter(function (g) { return g.ok; }).length > 0)
        || lifecycle.expired_headers > 0,
      scopes: scopes
    };
  })();

  var activeCount = writtenGroups.filter(function (g) { return g.ok; }).length;
  return jsonResponse_({
    success: runSucceeded,
    data: {
      mode: 'K2_ROUTE_GROUP', job_status: jobStatus, planningCycle: request.planningCycle, businessScope: scope0,
      // §G — the projection the frontend needs to refresh honestly.
      generation_run_id: generationRunId, execution_key: executionKey,
      scope: { company: scope0.company, country: scope0.country, marketplace: requestedMkt || null, planning_cycle: request.planningCycle },
      created_headers: writtenGroups.filter(function (g) { return g.ok && g.outcome === 'CREATED'; }).length,
      updated_headers: writtenGroups.filter(function (g) { return g.ok && (g.outcome === 'UPDATED' || g.outcome === 'REGENERATED' || g.outcome === 'REUSED'); }).length,
      created_lines: writtenGroups.filter(function (g) { return g.ok && g.outcome === 'CREATED'; }).reduce(function (a, g) { return a + (g.line_count || 0); }, 0),
      updated_lines: writtenGroups.filter(function (g) { return g.ok && g.outcome !== 'CREATED'; }).reduce(function (a, g) { return a + (g.line_count || 0); }, 0),
      expired_headers: lifecycle.expired_headers, expired_lines: lifecycle.expired_lines,
      active_count: activeCount, expired_count: lifecycle.expired_headers, zero_result: zeroResult,
      // ADDENDUM §B/§G — precedence is REPORTED, not implied. A caller must be able to tell "the AI had nothing
      // to say" from "the AI had something to say and the operator's decision outranked it", and to see the
      // recommendation that was withheld next to the quantity that was kept.
      all_suppressed_by_manual: allSuppressed,
      suppressed_count: suppressed.length,
      suppressed_by_active_manual_draft: suppressed,
      identity_collision_count: collisions.length,
      active_source_identity_collisions: collisions,
      // F1-7N-FC-1B-E3-R4-A2-R1-R4 §3 — THIS REPORTED THE VERSION IT EXPECTED, NOT THE ONE IT RAN ON.
      //
      // Found by probing a successful generation against a live-shaped 36-column sheet: the run resolved
      // FB4G-A2R3-CREATE-IDEMPOTENCY-1 and its own response said FB4C-AI-LIFECYCLE-1, because
      // AIPL_MIGRATION_VERSION_ is the EXPECTED constant and is deliberately frozen at the lifecycle append.
      // The activation gate already reports the resolved version correctly; only this success payload did not,
      // and this payload is what an operator reads after pressing Generate.
      //
      // It is the same mistake as the one §3 exists to fix, one layer along: a literal standing in for a
      // resolution. Both are now reported, named for what each one is, so they can never be confused again.
      schema_gate: (function () {
        var _r = null;
        try {
          if (typeof sadResolveHeaderSchema_ === 'function' && typeof sadLiveHeaderNames_ === 'function') {
            _r = sadResolveHeaderSchema_(sadLiveHeaderNames_(ss.getSheetByName('shipping_allocation_drafts')));
          }
        } catch (eSG) { _r = null; }
        return { ready: true,
          migration_version: (_r && _r.ok && _r.version) ? _r.version : null,
          resolved_from: _r ? 'LIVE_HEADER' : 'UNRESOLVED_AUTHORITY_UNAVAILABLE',
          expected_migration_version: (typeof AIPL_MIGRATION_VERSION_ !== 'undefined') ? AIPL_MIGRATION_VERSION_ : null };
      })(),
      verification: { lifecycle_ok: lifecycle.ok, lifecycle_reason: lifecycle.reason, detail: lifecycle.verification, manifest: lifecycle.manifest },
      lifecycle: lifecycle,
      requested_scope: { company: scope0.company, country: scope0.country, marketplace: requestedMkt || 'ALL_MARKETPLACES(company/country fan-out)' },
      applied_scope: { company: scope0.company, country: scope0.country, marketplaces: appliedList }, applied_equals_requested: scopeEqual ? 'YES' : 'NO',
      groups_written: groupsWritten.length, per_group_outcome_counts: outcomeCounts, groups: groupsWritten,
      blocked_count: blockedTotal.length, blocked: blockedTotal,
      conservation: conservationAll, batch: batchReport, advice: adviceReport,
      activation_mutation_manifest: weeklyAiPlanActivationManifest_(),
      skuCount: src.skuCount, unresolvedProductionNeedQty: src.unresolvedTotal,
      atomicity_note: 'Each K2 group is atomic under its own lock; the job is NOT a single all-or-nothing transaction across groups — a PARTIAL job is reported truthfully per group, and a retry REUSEs committed groups by deterministic identity (no duplicates). Superseded AI drafts are expired ONLY after this run has committed and verified.'
    },
    errors: (anyFail ? [weeklyAiPlanErr_('K2_GENERATION_PARTIAL', 'one or more K2 groups did not commit; see data.groups (per-group outcome)')] : [])
      .concat(lifecycle.attempted && lifecycle.ok === false
        ? [weeklyAiPlanErr_('AI_PLAN_EXPIRATION_INCOMPLETE', 'the current run committed, but superseded drafts were not fully expired; the previous plan may still be active. See data.lifecycle.', { reason: lifecycle.reason })]
        : [])
  });
}

/**
 * Harvest all canonical facts for the (company,country) universe. Returns
 * { ok, errors?, kmaf, horizonsByDemandRef, poolsBySku, warehousesById, sourceDataAsOf }.
 * LIVE-VERIFY: reuses existing owners only; assembles ONE multi-site KMAF receiver set (FORECAST_DRIVEN).
 */
function weeklyAiPlanHarvest_(ss, scope, expectedBySite) {
  var errors = [];
  // §E — the planning date this run belongs to, resolved from the SERVER's frozen planning config exactly
  // as 43_ resolves it when it materializes. Never a browser clock, never "now".
  var _cc = (typeof gapCalcResolveContext_ === 'function') ? gapCalcResolveContext_('INVENTORY') : null;
  var calcDateForDemand = (_cc && _cc.ok) ? _cc.calculationDate : null;
  // Pools + warehouses (headless readers, exact shapes per audit).
  var poolFacts = (typeof gapOpReadSupplyPoolFacts_ === 'function') ? gapOpReadSupplyPoolFacts_(ss) : null;
  if (!poolFacts) return { ok: false, errors: [weeklyAiPlanErr_('SUPPLY_POOL_FACTS_UNAVAILABLE', 'gapOpReadSupplyPoolFacts_ unavailable')] };
  var upcBySku = (typeof recGenUpcBySku_ === 'function') ? recGenUpcBySku_(ss) : {};
  var warehousesById = weeklyAiPlanWarehousesById_(ss);

  // Enumerate the eligible (marketplace, sku, destination) universe + per-site horizons via the recommendation
  // workspace (per marketplace). Each WAREHOUSE line carries sku, siteSku, warehouseId, horizons[].
  // F1-7N-FC-1B-E3-R4 §E — the canonical demand snapshot, read ONCE for the whole universe. A read or
  // schema failure here is FATAL: without it there is no authority for any quantity, and recomputing one is
  // exactly the divergence this closes.
  var canonical = weeklyAiPlanCanonicalDemand_(ss, scope, calcDateForDemand);
  if (!canonical.ok) {
    // §3 — the freshness verdict is carried out verbatim. "Not due yet" and "overdue" and "mid-write" are
    // three different operational situations and they must not arrive as one generic unavailability.
    return { ok: false, errors: [weeklyAiPlanErr_('CANONICAL_DEMAND_UNAVAILABLE',
      'the materialized demand snapshot could not be used: ' + canonical.reason,
      { table: WAP_GAP_TABLE_, reason: canonical.reason,
        freshness: canonical.freshness || null, schedule: canonical.schedule || null,
        distinct_dates: canonical.distinctDates || [],
        // §10 — how the date column READ, carried with the refusal. "LINEAGE_MISMATCH" and "we could not
        // read the date column at all" are different problems and they must not arrive looking the same.
        date_normalization: canonical.dateNormalization || null })] };
  }
  var sites = weeklyAiPlanEnumerateSites_(ss, scope, upcBySku, errors, canonical, expectedBySite); // [{ marketplace, sku, siteSku, destinationWarehouseId, cumulativeGapByWindow, requiredByByWindow, fulfillmentModel, allocationPriority, unitsPerCarton, sourceDataAsOf }]
  // §2 — THE UNIVERSE IS ENUMERATED, THEN NARROWED, AND THE NARROWING HAPPENS HERE.
  //
  // Everything above this line reads the whole (company,country) universe on purpose: the census, the
  // readiness report and the freshness verdict are all statements about the universe, and the enumeration is
  // also where per-site drops are collected. Everything BELOW this line computes numbers — KMAF share
  // weights, KMWRB source lines, the K2 allocator — and none of those may see a scope this run is not
  // authorized to write. `universe_site_count` is kept so a report can still say how large the universe was.
  var universeSiteCount = sites.length;
  var target = weeklyAiPlanTargetScopes_(scope, scope.marketplace);
  if (!target.ok) {
    return { ok: false, errors: [weeklyAiPlanErr_(target.reason,
      'the controlled activation scope could not be resolved, so no demand may enter the allocator',
      { scope: { company: scope.company, country: scope.country, marketplace: scope.marketplace || null },
        allowlist: (typeof inventoryAiPlanActivationAllowlist_ === 'function') ? inventoryAiPlanActivationAllowlist_() : null,
        universe_site_count: universeSiteCount, db_writes: 0 })] };
  }
  var iso = weeklyAiPlanIsolateSites_(sites, target);
  // §3 — and then ONE fact per canonical demand, before any of it is grouped or weighted.
  var coll = weeklyAiPlanCollapseCanonicalDemand_(iso.sites, scope, errors);
  sites = coll.sites;
  // R6-R7-R1 §B/§D/§E — THE RECOMMENDATION AUTHORITY AND THE RESIDUAL, RESOLVED HERE AND ONLY HERE.
  //
  // The state is asked of the canonical rows for the AUTHORIZED scopes, so a later stage never has to
  // reconstruct 'was that a zero or a nothing?' from the shape of an empty array. The netting then removes
  // demand an operator has already planned, BEFORE the allocator sizes anything — which is the only point
  // at which 'generate the residual' can mean what it says.
  var _recState = weeklyAiPlanRecommendationState_(canonical, target);
  var _planned = weeklyAiPlanQualifyingPlannedQty_(ss, scope);
  var _residual = weeklyAiPlanNetSitesByResidual_(sites, _planned.byKey, scope);
  var _noAction = weeklyAiPlanNoActionDecision_(_recState, _planned);
  var isolation = {
    enforced: true, stage: 'PRE_CANONICAL_GROUPING',
    target_scopes: target.scopes, requested_marketplace: target.requested_marketplace,
    universe_site_count: universeSiteCount,
    target_site_count: iso.target_site_count, target_sku_count: iso.target_sku_count,
    foreign_site_count: iso.foreign_site_count, foreign_sku_count: iso.foreign_sku_count,
    foreign_sample: iso.foreign_sample,
    canonical_demand_count: coll.canonical_demand_count,
    collapsed_site_count: coll.collapsed_site_count,
    canonical_demand_conflicts: coll.conflicts, canonical_demand_conflict_count: coll.conflict_count
  };
  // A canonical-demand conflict is a refusal, not a warning: it means one demand would be counted twice.
  if (coll.conflict_count) {
    return { ok: false, errors: errors.concat([weeklyAiPlanErr_('CANONICAL_DEMAND_QUANTITY_CONFLICT',
      'one canonical demand carries two different quantities; zero rows written',
      { conflicts: coll.conflicts, isolation: isolation, db_writes: 0 })]) };
  }
  // §6 — the cutoff, from the DONE GAP-INV run and from nowhere else. Resolved BEFORE the early returns
  // below so that a zero-demand answer carries the same lineage a full one does.
  var asOf = weeklyAiPlanSourceDataAsOfAuthority_(scope.planningCycle);
  if (!asOf.ok) {
    return { ok: false, errors: [weeklyAiPlanErr_('SOURCE_DATA_AS_OF_UNRESOLVED',
      'the authoritative GAP-INV run cutoff could not be resolved (' + asOf.reason + '); zero rows written',
      { reason: asOf.reason, planning_cycle: scope.planningCycle, isolation: isolation, db_writes: 0 })] };
  }
  // F1-7N-FC-1B-E3-R1 §D — `errors` IS CARRIED OUT. Every non-fatal drop this function makes lands in
  // that array (WORKSPACE_NOT_OK / WORKSPACE_THREW per marketplace, FORECAST_SHARE_INCOMPLETE per site) and both
  // SUCCESS returns used to discard it. When every site was dropped, the consequence was exact and total: zero
  // receivers → KMAF ready:false with issues:[] → mapper ready:false with issues:[] → a bare
  // HARVEST_NOT_READY. The reason was known at THIS line and thrown away three lines later.
  // R6-R7-R1 — the zero-site return is the one that used to lose the answer. It carries the authority now.
  if (!sites.length) return { ok: true, errors: errors, site_count: 0, kmaf: { ready: true, receiverFacts: [], planningFacts: [] }, horizonsByDemandRef: {}, poolsBySku: weeklyAiPlanPoolsBySku_(poolFacts, scope), warehousesById: warehousesById,
    recommendationState: _recState, qualifyingPlanned: _planned, residual: _residual, noActionDecision: _noAction,
    sourceDataAsOf: asOf.date, sourceDataAsOfAuthority: { run_id: asOf.run_id, date: asOf.date, source: 'GAP_INV_RUN_LINEAGE' },
    gapLineage: asOf.lineage, isolation: isolation, snapshot_freshness: canonical.freshness || null,
    accepted_snapshot_date: canonical.acceptedDate || null, gap_schedule: canonical.schedule || null,
    gap_job_state: canonical.jobState || null, snapshot_distinct_dates: canonical.distinctDates || [],
    snapshot_date_normalization: canonical.dateNormalization || null };

  // Build ONE multi-site KMAF receiver set (FORECAST_DRIVEN; §7 forecastShareQty basis) so demandWeight normalizes
  // ONCE across the whole (company,country) universe. demandRef encodes (marketplace|sku|destination) for join-back.
  var built = weeklyAiPlanBuildKmafReceivers_(ss, scope, sites, upcBySku, errors);
  if (built.fatal) return { ok: false, errors: errors };

  var kmaf;
  try {
    kmaf = KMAF.projectAllocationFacts({
      recommendationType: 'WEEKLY_SHIPPING', planningCycle: scope.planningCycle,
      businessScope: { company: scope.company, country: scope.country },
      calculationDate: built.calculationDate, receivers: built.receivers, warehouses: built.kmafWarehouses
    });
  } catch (e) {
    return { ok: false, errors: [weeklyAiPlanErr_('KMAF_THREW', (e && e.message) ? String(e.message) : String(e))] };
  }

  // horizons keyed by the SAME demandRef the KMAF receiver used.
  var horizonsByDemandRef = {};
  built.horizonRows.forEach(function (r) { horizonsByDemandRef[r.demandRef] = { cumulativeGapByWindow: r.cumulativeGapByWindow,
    requiredByByWindow: r.requiredByByWindow, demandLineage: r.demandLineage || null, liveGapByWindow: r.liveGapByWindow || null }; });

  return {
    ok: true, kmaf: kmaf, horizonsByDemandRef: horizonsByDemandRef,
    poolsBySku: weeklyAiPlanPoolsBySku_(poolFacts, scope), warehousesById: warehousesById,
    // §6 — ONE authority. `built.sourceDataAsOf` is the recommendation-workspace line's own value and is
    // kept ONLY as a diagnostic, so a report can show that it is blank without anything depending on it.
    sourceDataAsOf: asOf.date,
    sourceDataAsOfAuthority: { run_id: asOf.run_id, date: asOf.date, source: 'GAP_INV_RUN_LINEAGE' },
    workspaceSourceDataAsOf: built.sourceDataAsOf || null,
    gapLineage: asOf.lineage,
    // §2/§3 — what was narrowed, and what one canonical demand turned out to be.
    isolation: isolation,
    // §D — the diagnostics this function collected. `errors` is the per-site drop list the mapper turns
    // into typed readiness issues; the counts are what make "every site was dropped" readable as one number.
    errors: errors, site_count: sites.length, receiver_count: (built.receivers || []).length,
    // §G — the receivers themselves, so the no-demand verdict can read each basis rather than infer one
    // from an error code. Diagnostic only: nothing downstream allocates from this field.
    builtReceivers: built.receivers || [],
    // §1 — the normalization audit, so a report can state how many months were real, how many were an
    // explicit zero, and how many were defaulted — without re-deriving any of it.
    forecast_normalization: built.forecastNormalization || null,
    // R6-R7-R1 — the recommendation state, the qualifying plan and the residual, carried out rather than
    // re-derived. One authority, so a census and a live generation can never disagree about the number.
    recommendationState: _recState, qualifyingPlanned: _planned, residual: _residual, noActionDecision: _noAction,
    // §3 — which run was adopted and why, so the report never has to infer it.
    snapshot_freshness: canonical.freshness || null,
    accepted_snapshot_date: canonical.acceptedDate || null,
    gap_schedule: canonical.schedule || null,
    gap_job_state: canonical.jobState || null,
    snapshot_distinct_dates: canonical.distinctDates || [],
    snapshot_date_normalization: canonical.dateNormalization || null
  };
}

/**
 * §E.2 — normalize the caller's declared expectation into { 'company|country|marketplace|sku': {WINDOW: qty} }.
 * The DOM is not a source of truth and this does not make it one: these values are only ever COMPARED against
 * the canonical row, never substituted for it, and a disagreement refuses rather than choosing.
 */
function weeklyAiPlanExpectedDemand_(body, company, country) {
  var list = (body && Array.isArray(body.expectedDemand)) ? body.expectedDemand : null;
  if (!list || !list.length) return null;
  var out = {};
  for (var i = 0; i < list.length; i++) {
    var e = list[i] || {};
    var mk = weeklyAiPlanStr_(e.marketplace), sku = weeklyAiPlanStr_(e.sku);
    if (!mk || !sku) continue;
    var key = company + '|' + country + '|' + mk + '|' + sku;
    var byWin = {};
    var src = (e.suggestedByWindow && typeof e.suggestedByWindow === 'object') ? e.suggestedByWindow : {};
    for (var w in src) { if (Object.prototype.hasOwnProperty.call(src, w)) byWin[w] = src[w]; }
    out[key] = byWin;
  }
  return out;
}

/** Index raw `warehouses` rows by warehouse_id with the raw columns KMWHA.validateFactoryConfig needs. */
function weeklyAiPlanWarehousesById_(ss) {
  var out = {};
  if (typeof gapReadObjects_ !== 'function') return out;
  var rows = gapReadObjects_(ss, 'warehouses') || [];
  rows.forEach(function (r) {
    var id = weeklyAiPlanStr_(r.warehouse_id);
    if (!id) return;
    // §4 — `warehouse_code` was never indexed, so every line's source_warehouse_code_snapshot and every
    // diagnostic that printed a warehouse code read blank. The identity stays the id; the code is evidence.
    out[id] = { warehouse_id: id, warehouse_code: weeklyAiPlanStr_(r.warehouse_code),
      warehouse_type: weeklyAiPlanStr_(r.warehouse_type), is_factory_warehouse: r.is_factory_warehouse,
      is_active: r.is_active, country: weeklyAiPlanStr_(r.country) };
  });
  return out;
}

/** Reshape gapOpReadSupplyPoolFacts_ into { [sku]: { overseasSupplyPools[], factoryPools[] } } for the scope. */
function weeklyAiPlanPoolsBySku_(poolFacts, scope) {
  var out = {}, canonCountry = (typeof gapCanonCountry_ === 'function') ? gapCanonCountry_(scope.country) : scope.country;
  var factoryBySku = poolFacts.factoryPoolsBySku || {};
  for (var sku in factoryBySku) { if (factoryBySku.hasOwnProperty(sku)) { out[sku] = out[sku] || { overseasSupplyPools: [], factoryPools: [] }; out[sku].factoryPools = factoryBySku[sku]; } }
  var overseasByKey = poolFacts.overseasPoolsByKey || {};
  for (var key in overseasByKey) {
    if (!overseasByKey.hasOwnProperty(key)) continue;
    var parts = key.split('||'); // company||canonicalCountry||sku
    if (parts.length !== 3 || parts[0] !== scope.company || parts[1] !== canonCountry) continue;
    var s = parts[2]; out[s] = out[s] || { overseasSupplyPools: [], factoryPools: [] }; out[s].overseasSupplyPools = overseasByKey[key];
  }
  return out;
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R3 §6 — THE FIRST SURVIVING WORKSPACE LINE WAS NEVER AN AUTHORITY ON ANYTHING.
//
// This function decided the whole run's `sourceDataAsOf` by scanning the sites and taking the first non-blank
// value it found. Every consequence of that was wrong at once:
//
//   * The recommendation-workspace line does not carry the cutoff for most scopes, so the answer was BLANK —
//     which the mapper reports as a NON-BLOCKING predicate, so the run continued with no cutoff at all.
//   * weeklyAiPlanShipDate_ reads it, so `shipDate` was '' for the live scope. KMRA then date-gates NOTHING
//     (a null as-of skips the effective-window filter) and KMWRR's on-time test degrades to "is there any
//     lead time at all". A plan was being ranked with no ship date.
//   * WHICH line was first depended on enumeration order, so the value was not even stable.
//
// The authority already existed and was already correct: the DONE GAP-INV run persists its own frozen input
// cutoff (`calculationDate`), which is exactly the business-data cutoff the calculation consumed. R6F2G2 said
// so in a comment beside weeklyAiPlanResolveGapRunLineage_ — and then the harvest went on using the workspace
// line anyway. So there is now ONE authority, it is that run, and its date goes through the A2-R1-R1 canonical
// Taipei normalizer like every other date. No clock, no file modification time, no fallback: a run whose
// lineage is missing or contradictory FAILS CLOSED rather than planning against a date nobody owns.
function weeklyAiPlanSourceDataAsOfAuthority_(planningCycle) {
  var lin = weeklyAiPlanResolveGapRunLineage_(planningCycle, null, null);
  if (!lin.ok) return { ok: false, reason: lin.reason, date: null, run_id: null, lineage: null };
  var cd = weeklyAiPlanCanonicalDate_(lin.source_data_as_of);
  if (!cd.ok) return { ok: false, reason: 'LINEAGE_SOURCE_DATA_AS_OF_UNREADABLE:' + cd.reason,
    date: null, run_id: lin.run_id, lineage: lin };
  return { ok: true, reason: null, date: cd.date, run_id: lin.run_id, lineage: lin };
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R3 §2 — EXACT CONTROLLED-SCOPE ISOLATION, BEFORE THE ALLOCATOR AND NOT AFTER IT.
//
// A2-R1 put the activation allowlist at the WRITER on a deliberate argument: a census and a readiness report
// must be able to SEE every scope, and refusing to look is blindness rather than safety. That argument is
// still right about READING. It was wrong about COMPUTING, and the live run showed the difference:
//
//   * the harvest enumerated the whole (company,country) universe — 92 receiver facts for a run authorized for
//     ONE sku — and every one of them entered KMAF, KMWRB and the K2 allocator;
//   * so 157 source lines and 114 allocated lines were computed, of which all but a handful were foreign;
//   * the foreign lines then decided the shape of the answer. They formed the only route group, they supplied
//     every duplicate in `duplicate_sku_window_in_group`, and they made `conserved:false` a property of SKUs
//     the run was never allowed to write.
//
// Filtering at the writer cannot undo any of that, because by then the numbers have already been computed
// together. So the demand facts are narrowed HERE, before canonical grouping and before the allocator, and
// the narrowing is an INTER§ION of two things the client cannot influence: the server-owned allowlist, and
// the marketplace the request named. A site-level request can only ever narrow the allowlist further — there
// is no direction in which a payload widens it, and an empty marketplace is not "all", it is "no constraint
// beyond the allowlist", which the allowlist then constrains to its own exact four-part entries.
//
// Shared authorities — warehouses, factory stock, carrier cards, lead times, the route authority — are still
// read WHOLE, because computing this SKU's answer needs them. What is narrowed is the DEMAND that enters the
// allocator, which is the thing that was leaking.
function weeklyAiPlanTargetScopes_(scope, requestedMarketplace) {
  if (typeof inventoryAiPlanActivationAllowlist_ !== 'function' || typeof inventoryAiPlanScopeEnabled_ !== 'function') {
    return { ok: false, reason: 'AI_PLAN_SCOPE_GUARD_UNAVAILABLE', scopes: [], requested_marketplace: null };
  }
  var mk = weeklyAiPlanStr_(requestedMarketplace);
  // ALL_SITES is not a scope, and it must not become one by being unrecognised.
  if (/^all(_sites)?$/i.test(mk)) {
    return { ok: false, reason: 'SCOPE_ALL_SITES_FORBIDDEN', scopes: [], requested_marketplace: mk };
  }
  var out = [];
  (inventoryAiPlanActivationAllowlist_() || []).forEach(function (e) {
    var c = weeklyAiPlanStr_(e.company), k = weeklyAiPlanStr_(e.country),
        m = weeklyAiPlanStr_(e.marketplace), sk = weeklyAiPlanStr_(e.sku);
    if (c !== weeklyAiPlanStr_(scope.company) || k !== weeklyAiPlanStr_(scope.country)) return;
    if (mk && m !== mk) return;                       // INTER§ION: a named marketplace narrows, never widens
    // The gate itself is re-asked rather than trusted from the list, so a blank/ALL entry can never pass even
    // if one were ever added to the config by hand.
    if (!inventoryAiPlanScopeEnabled_(c, k, m, sk)) return;
    out.push({ company: c, country: k, marketplace: m, sku: sk });
  });
  if (!out.length) {
    return { ok: false, reason: 'AI_PLAN_SCOPE_NOT_ENABLED', scopes: [], requested_marketplace: mk || null };
  }
  return { ok: true, reason: null, scopes: out, requested_marketplace: mk || null };
}

/** The (marketplace|sku) key set a target scope authorizes. Exact and case-sensitive, like the gate. */
function weeklyAiPlanTargetKeySet_(target) {
  var keep = {};
  ((target && target.scopes) || []).forEach(function (e) { keep[e.marketplace + '|' + e.sku] = 1; });
  return keep;
}

/**
 * §2 — keep only the authorized demand facts. Foreign facts are DROPPED AND COUNTED, never silently included
 * and never silently discarded: a report has to be able to say how many there were and name a few.
 */
function weeklyAiPlanIsolateSites_(sites, target) {
  var keep = weeklyAiPlanTargetKeySet_(target);
  var kept = [], foreign = [], fSkus = {}, tSkus = {};
  (sites || []).forEach(function (st) {
    var m = weeklyAiPlanStr_(st.marketplace), sk = weeklyAiPlanStr_(st.sku);
    if (keep[m + '|' + sk]) { kept.push(st); tSkus[sk] = 1; return; }
    fSkus[sk] = 1;
    if (foreign.length < 10) foreign.push({ marketplace: m, sku: sk });
  });
  return { sites: kept,
    target_site_count: kept.length, target_sku_count: Object.keys(tSkus).length,
    foreign_site_count: (sites || []).length - kept.length, foreign_sku_count: Object.keys(fSkus).length,
    foreign_sample: foreign };
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R3 §3 — ONE CANONICAL DEMAND, COUNTED ONCE, WITH ITS LINEAGE KEPT.
//
// The recommendation workspace enumerates one line per SITE SKU. The canonical demand snapshot is keyed per
// MASTER sku: (company, country, marketplace, sku). So a master sku with two site skus in one marketplace —
// two ASINs of the same product, which is ordinary — produced TWO sites, and
// weeklyAiPlanAcceptCanonicalDemand_ gave EACH of them the SAME snapshot quantity. The demand was therefore
// claimed twice: 760 units of canonical demand entered the allocator as 1520.
//
// Downstream, KMWRB's demandKey is (masterSku|marketplace|windowCode) — it does not carry the site sku either —
// so one of the two lines was dropped with a DUPLICATE_WEEKLY_LINE_KEY issue and the other kept. That accident
// is the only reason the shipped quantity was not doubled, and it is the wrong mechanism twice over: the
// surviving line depends on enumeration order, and the issue reads like a data fault rather than the
// structural double-count it actually was.
//
// So the collapse happens HERE, at the boundary that owns canonical demand, and it AGGREGATES rather than
// dropping: one demand fact per (company, country, marketplace, sku, destination), the quantity taken from the
// snapshot ONCE, and every contributing site sku retained on the fact as lineage. The representative site sku
// is the lexicographic minimum — deterministic, and never "whichever the enumeration reached first".
//
// It REFUSES rather than choosing when two sites of one canonical demand disagree about the quantity. That
// cannot happen while the quantity comes from the snapshot (both read the same row), and if it ever does it
// means the snapshot is being read inconsistently, which is not something to average.
function weeklyAiPlanCanonicalDemandRef_(scope, site) {
  return [weeklyAiPlanStr_(scope.company), weeklyAiPlanStr_(scope.country), weeklyAiPlanStr_(site.marketplace),
    weeklyAiPlanStr_(site.sku), weeklyAiPlanStr_(site.destinationWarehouseId)].join('|');
}
function weeklyAiPlanCollapseCanonicalDemand_(sites, scope, errors) {
  var byRef = {}, order = [], collapsed = 0, conflicts = [];
  (sites || []).forEach(function (st) {
    var ref = weeklyAiPlanCanonicalDemandRef_(scope, st);
    var held = byRef[ref];
    if (!held) {
      st.demandRef = ref;
      st.siteSkus = [weeklyAiPlanStr_(st.siteSku)];
      byRef[ref] = st; order.push(ref);
      return;
    }
    // The SAME canonical demand. Its quantity is the snapshot's and must be counted once.
    var a = JSON.stringify(held.cumulativeGapByWindow || {}), b = JSON.stringify(st.cumulativeGapByWindow || {});
    if (a !== b) {
      conflicts.push({ demandRef: ref, sku: weeklyAiPlanStr_(st.sku), marketplace: weeklyAiPlanStr_(st.marketplace),
        site_sku_a: held.siteSkus.join(','), site_sku_b: weeklyAiPlanStr_(st.siteSku), qty_a: a, qty_b: b });
      return;
    }
    var ssk = weeklyAiPlanStr_(st.siteSku);
    if (ssk && held.siteSkus.indexOf(ssk) < 0) held.siteSkus.push(ssk);
    collapsed++;
  });
  var out = order.map(function (ref) {
    var st = byRef[ref];
    st.siteSkus = st.siteSkus.slice().sort();
    st.siteSku = st.siteSkus[0] || weeklyAiPlanStr_(st.siteSku);   // deterministic representative
    return st;
  });
  if (conflicts.length && Array.isArray(errors)) {
    conflicts.forEach(function (c) {
      errors.push(weeklyAiPlanErr_('CANONICAL_DEMAND_QUANTITY_CONFLICT',
        'two sites of one canonical demand disagree about the quantity; refused rather than reconciled', c));
    });
  }
  return { sites: out, collapsed_site_count: collapsed, conflict_count: conflicts.length,
    conflicts: conflicts.slice(0, 10), canonical_demand_count: out.length };
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R1 §B/§C/§D/§E — A VALID ZERO IS AN ANSWER, NOT A MISSING SCOPE.
//
// THE CONTRADICTION THIS CLOSES. The materialized row for ResUS/US/Amazon/CO1100-R is READY and every window
// holds a stored, finite 0: the SKU needs nothing. The generation path read that as follows —
//
//     zero canonical demand  ->  the recommendation workspace enumerates no shortage line
//                            ->  weeklyAiPlanEnumerateSites_ returns []
//                            ->  the harvest returns ok with site_count 0
//                            ->  KMWRB produces 0 source lines, the K2 allocator 0 allocated lines
//                            ->  byMkt['Amazon'] is undefined
//                            ->  REQUESTED_SCOPE_EMPTY, success:false
//
// — and REQUESTED_SCOPE_EMPTY means "the requested marketplace produced no allocated lines", which is the
// SAME sentence for "this SKU needs nothing today" and for "you asked for a scope that is not there". Those
// are opposite operational situations: one is a correct finish, the other is a fault to investigate. The
// existing no-demand verdict could not tell them apart either, because its very first gate is
// `if (!receivers.length) return NO_RECEIVERS_BUILT` — and a zero-need scope builds no receivers.
//
// WHAT DECIDES IT is the only thing that can: the canonical row itself, which the harvest has already read.
// A row that is READY at the accepted snapshot date with a finite number in every required window is a
// STATEMENT, and the statement is "zero". A row that is absent, BLOCKED, duplicated, from another run, or
// holding a blank where a number belongs is not a statement at all, and nothing may be concluded from it.
//
// MISSING IS NEVER ZERO. Every reader below returns null for an absent value and never coerces one, because
// the whole defect class this round closes is a blank being read as a quantity.
// ================================================================================================================
var WAP_RECOMMENDATION_STATES_ = {
  VALID_ZERO: 'VALID_ZERO_RECOMMENDATION',
  NONZERO: 'NONZERO_RECOMMENDATION',
  MISSING: 'MISSING_RECOMMENDATION'
};
// The formal outcome name for "the correct amount to generate is nothing". It travels BESIDE the existing
// NO_REPLENISHMENT_REQUIRED / zero_result / NO_DEMAND keys rather than replacing them: the shipped page
// classifies a zero result from those three, and a success shape it cannot recognise is reported to the
// operator as a generic failure — which is the exact outcome this round exists to stop producing.
var WAP_NO_ACTION_CODE_ = 'AI_PLAN_NO_ACTION';

/** MISSING vs ZERO, once, for every numeric read below. '' / null / undefined / non-finite → null. */
function weeklyAiPlanQty_(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * §B/§D — THE ONE RECOMMENDATION AUTHORITY, asked about an EXACT scope.
 *
 * `canonical` is what weeklyAiPlanCanonicalDemand_ already produced: rows keyed by
 * company|country|marketplace|sku, narrowed to the ACCEPTED snapshot date by the freshness authority, so
 * "current run" is established before this function is called rather than re-litigated inside it.
 *
 * `target` is weeklyAiPlanTargetScopes_'s answer — the allowlisted scopes this run may write. Asking about
 * anything else would be asking about a scope the run cannot act on.
 *
 * The per-scope quantity is the FURTHEST configured window, which is the same rule the page's standing
 * authority uses (_irSuggestedQtyState_ → d90_suggested_qty). The windows are CUMULATIVE checkpoints, so the
 * furthest one is the single actionable total and summing them would double-count need.
 */
function weeklyAiPlanRecommendationState_(canonical, target) {
  var order = ['D18', 'D30', 'D45', 'D90'];
  var windows = [];
  order.forEach(function (w) { if (Object.prototype.hasOwnProperty.call(WAP_GAP_WINDOW_COL_, w)) windows.push(w); });
  for (var extra in WAP_GAP_WINDOW_COL_) {
    if (Object.prototype.hasOwnProperty.call(WAP_GAP_WINDOW_COL_, extra) && windows.indexOf(extra) === -1) windows.push(extra);
  }
  var furthest = windows.length ? windows[windows.length - 1] : null;
  var out = {
    state: WAP_RECOMMENDATION_STATES_.MISSING,
    authority_rule: 'inventory_replenishment_gap, the row at the ACCEPTED snapshot date for the exact'
      + ' (company, country, marketplace, sku). The quantity is the FURTHEST cumulative window ('
      + (furthest || 'none configured') + '), which is the single actionable total; the windows are'
      + ' cumulative checkpoints and summing them would double-count need.',
    windows_required: windows.slice(),
    furthest_window: furthest,
    accepted_calculation_date: (canonical && canonical.acceptedDate) || null,
    snapshot_freshness_state: (canonical && canonical.freshnessState) || null,
    current_run: null,
    per_scope: [],
    recommended_qty_total: null,
    evaluated_scope_count: 0,
    missing_reasons: []
  };
  if (!canonical || canonical.ok !== true) {
    out.missing_reasons.push({ reason: 'CANONICAL_DEMAND_UNAVAILABLE', detail: (canonical && canonical.reason) || null });
    return out;
  }
  out.current_run = {
    calculation_date: canonical.acceptedDate || null,
    freshness_state: canonical.freshnessState || null,
    gap_job: canonical.jobState || null,
    distinct_dates: canonical.distinctDates || []
  };
  var scopes = (target && target.scopes) || [];
  if (!scopes.length) {
    out.missing_reasons.push({ reason: 'NO_AUTHORIZED_SCOPE', detail: (target && target.reason) || null });
    return out;
  }
  var total = 0, anyMissing = false, anyPositive = false;
  scopes.forEach(function (s) {
    var key = s.company + '|' + s.country + '|' + s.marketplace + '|' + s.sku;
    var row = canonical.bySite ? canonical.bySite[key] : null;
    var entry = { company: s.company, country: s.country, marketplace: s.marketplace, sku: s.sku,
      key: key, evaluated: false, reason: null, calculation_status: null, calculation_date: null,
      calculated_at: null, windows: {}, recommended_qty: null };
    if (!row) {
      entry.reason = 'NO_ROW_AT_THE_ACCEPTED_DATE';
      anyMissing = true; out.per_scope.push(entry); out.missing_reasons.push({ key: key, reason: entry.reason });
      return;
    }
    entry.calculation_status = row.calculation_status || null;
    entry.calculation_date = row.calculation_date || null;
    entry.calculated_at = row.calculated_at || null;
    if (row.duplicate === true) {
      entry.reason = 'DUPLICATE_ROW_FOR_THIS_KEY';
      anyMissing = true; out.per_scope.push(entry); out.missing_reasons.push({ key: key, reason: entry.reason });
      return;
    }
    if (weeklyAiPlanStr_(row.calculation_status) !== 'READY') {
      // BLOCKED and ERROR leave the quantities blank by contract (43_). A non-READY row carries no number,
      // and reading its blanks as zero is the defect the materializer refuses to commit.
      entry.reason = 'NOT_READY:' + (weeklyAiPlanStr_(row.calculation_status) || '(blank)');
      anyMissing = true; out.per_scope.push(entry); out.missing_reasons.push({ key: key, reason: entry.reason });
      return;
    }
    var blank = null;
    windows.forEach(function (w) {
      var v = weeklyAiPlanQty_(row.suggestedByWindow ? row.suggestedByWindow[w] : null);
      entry.windows[w] = v;
      if (v === null && blank === null) blank = w;
    });
    if (blank !== null) {
      entry.reason = 'WINDOW_VALUE_MISSING:' + blank;
      anyMissing = true; out.per_scope.push(entry); out.missing_reasons.push({ key: key, reason: entry.reason });
      return;
    }
    entry.evaluated = true;
    entry.recommended_qty = furthest ? entry.windows[furthest] : null;
    if (entry.recommended_qty === null) {
      entry.evaluated = false;
      entry.reason = 'NO_CONFIGURED_WINDOW';
      anyMissing = true; out.per_scope.push(entry); out.missing_reasons.push({ key: key, reason: entry.reason });
      return;
    }
    // A positive value in ANY window is a need, even when the furthest one has closed: the earlier shortage
    // is real and is what the allocator plans against. The furthest window remains the reported total.
    windows.forEach(function (w) { if (entry.windows[w] > 0) anyPositive = true; });
    total += entry.recommended_qty;
    out.evaluated_scope_count++;
    out.per_scope.push(entry);
  });
  if (anyMissing) { out.state = WAP_RECOMMENDATION_STATES_.MISSING; return out; }
  out.recommended_qty_total = total;
  out.state = anyPositive ? WAP_RECOMMENDATION_STATES_.NONZERO : WAP_RECOMMENDATION_STATES_.VALID_ZERO;
  return out;
}

/**
 * §E — THE QUALIFYING ACTIVE PLAN, counted per exact (company, country, marketplace, sku).
 *
 * "Qualifying" is deliberately narrow. A header qualifies only when all four scope axes match EXACTLY, its
 * status is not terminal, AND IT IS NOT AN AI DRAFT; a line qualifies only when its sku matches and its own
 * line status is not terminal. A row for another marketplace, another SKU, another company or a
 * submitted/cancelled/expired plan is not part of what is already planned here, and counting one would make
 * the residual too small — which is the error that silently under-generates.
 *
 * THE AI EXCLUSION IS NOT A DETAIL. A generation supersedes its own previous drafts through the lifecycle, so
 * a row on its way to `expired` is not a commitment anybody is holding. Counting one would net a run against
 * its own last output and make regeneration impossible for ever — which is what happened, and what the R4
 * carrier-authority suite caught. It is also what the contract is FOR: an OPERATOR's decision outranks a
 * recommendation, and an earlier recommendation does not.
 *
 * The terminal sets are READ from 16_ and the provenance from 69_'s own classifier, rather than restated, so
 * "which statuses still count" and "is this row AI's?" each keep the one answer they already have.
 */
/** Provenance, through 69_'s classifier when it is loaded. The fallback is the SAME two rules, and it is
 *  named in `provenance_authority` so a project missing 69_ is a stated fact rather than a silent one. */
function weeklyAiPlanIsAiRow_(row) {
  if (typeof aiplIsAiGenerated_ === 'function') return aiplIsAiGenerated_(row);
  var gt = weeklyAiPlanStr_(row && row.generation_type).toLowerCase();
  if (gt === 'user_created') return false;
  if (gt === 'system_generated' || gt === 'scheduled' || gt === 'manual_refresh') return true;
  return !!weeklyAiPlanStr_(row && row.generation_run_id);
}

function weeklyAiPlanQualifyingPlannedQty_(ss, scope) {
  var termH = (typeof SAD_TERMINAL_STATUSES_ !== 'undefined') ? SAD_TERMINAL_STATUSES_ : { submitted: 1, cancelled: 1, expired: 1 };
  var termL = (typeof SAD_TERMINAL_LINE_STATUSES_ !== 'undefined') ? SAD_TERMINAL_LINE_STATUSES_
    : { submitted: 1, cancelled: 1, expired: 1, superseded: 1, superseded_user_review: 1 };
  var out = { ok: false, reason: null, byKey: {}, rows: [], header_count: 0, line_count: 0,
    excluded: { terminal_header: 0, terminal_line: 0, scope_mismatch: 0, no_header: 0, blank_qty: 0,
      ai_generated_header: 0 },
    authority: 'header company/country/marketplace + line sku, all EXACT; non-terminal header status;'
      + ' non-terminal line status; and MANUAL provenance only (16_ SAD_TERMINAL_STATUSES_ /'
      + ' SAD_TERMINAL_LINE_STATUSES_, 69_ aiplIsAiGenerated_). An AI draft this run would supersede is not'
      + ' an existing commitment and is never counted as one.',
    provenance_authority: (typeof aiplIsAiGenerated_ === 'function') ? 'aiplIsAiGenerated_ (69_)' : 'FALLBACK' };
  if (typeof gapReadObjects_ !== 'function') { out.reason = 'SHEET_READER_UNAVAILABLE'; return out; }
  var headers, lines;
  try {
    headers = gapReadObjects_(ss, 'shipping_allocation_drafts') || [];
    lines = gapReadObjects_(ss, 'shipping_allocation_draft_lines') || [];
  } catch (e) { out.reason = 'ALLOCATION_DRAFT_READ_FAILED'; return out; }
  var byId = {};
  headers.forEach(function (h) {
    var st = weeklyAiPlanStr_(h.status).toLowerCase();
    if (termH[st]) { out.excluded.terminal_header++; return; }
    if (weeklyAiPlanStr_(h.company) !== weeklyAiPlanStr_(scope.company)
      || weeklyAiPlanStr_(h.country) !== weeklyAiPlanStr_(scope.country)) { out.excluded.scope_mismatch++; return; }
    if (weeklyAiPlanIsAiRow_(h)) { out.excluded.ai_generated_header++; return; }
    byId[weeklyAiPlanStr_(h.allocation_draft_id)] = h;
    out.header_count++;
  });
  lines.forEach(function (l) {
    var h = byId[weeklyAiPlanStr_(l.allocation_draft_id)];
    if (!h) { out.excluded.no_header++; return; }
    var ls = weeklyAiPlanStr_(l.line_status).toLowerCase();
    if (termL[ls]) { out.excluded.terminal_line++; return; }
    var q = weeklyAiPlanQty_(l.planned_qty);
    if (q === null) { out.excluded.blank_qty++; return; }
    var key = weeklyAiPlanStr_(h.company) + '|' + weeklyAiPlanStr_(h.country) + '|'
      + weeklyAiPlanStr_(h.marketplace) + '|' + weeklyAiPlanStr_(l.sku);
    out.byKey[key] = (out.byKey[key] || 0) + q;
    out.line_count++;
    if (out.rows.length < 50) {
      out.rows.push({ key: key, allocation_draft_id: weeklyAiPlanStr_(h.allocation_draft_id),
        allocation_draft_line_id: weeklyAiPlanStr_(l.allocation_draft_line_id),
        status: weeklyAiPlanStr_(h.status), line_status: weeklyAiPlanStr_(l.line_status), planned_qty: q });
    }
  });
  out.ok = true;
  return out;
}

/**
 * §E — THE RESIDUAL. residual = max(recommended - qualifying planned, 0).
 *
 * The clamp at zero is the whole rule for the over-planned case: a plan larger than the recommendation is
 * EXCESS, and an AI generation NEVER reduces, cancels or reclaims an operator's route to bring the total back
 * down. It simply has nothing left to add.
 *
 * A NULL recommendation stays null. Treating an unknown as zero would report NO_ACTION for a scope nobody
 * could read, which is exactly the conflation §B exists to remove.
 */
function weeklyAiPlanResidualQty_(recommendedQty, plannedQty) {
  var r = weeklyAiPlanQty_(recommendedQty);
  if (r === null) return null;
  var p = weeklyAiPlanQty_(plannedQty);
  if (p === null) p = 0;
  var d = r - p;
  return d > 0 ? d : 0;
}

/**
 * §E — NET THE CANONICAL DEMAND BY WHAT IS ALREADY PLANNED, before anything is grouped, weighted or routed.
 *
 * This is the only place the residual can be applied and still mean what it says. Applying it later would let
 * the allocator size routes against demand that is already covered, which is how a generation comes to write
 * a second plan for units an operator has already planned.
 *
 * Each window is reduced by the SAME qualifying planned quantity, because the windows are cumulative: a unit
 * already planned covers the earliest need first and therefore reduces the shortage at every later checkpoint
 * by the same amount. Clamped at zero per window, never negative.
 *
 * Sites are NOT dropped when they net to zero. A dropped site is indistinguishable from a site that was never
 * there, and telling those two apart is the entire subject of this round.
 */
function weeklyAiPlanNetSitesByResidual_(sites, plannedByKey, scope) {
  var report = { applied: true, netted_site_count: 0, fully_covered_site_count: 0, by_key: [] };
  (sites || []).forEach(function (st) {
    var key = weeklyAiPlanStr_(scope.company) + '|' + weeklyAiPlanStr_(scope.country) + '|'
      + weeklyAiPlanStr_(st.marketplace) + '|' + weeklyAiPlanStr_(st.sku);
    var planned = weeklyAiPlanQty_((plannedByKey || {})[key]);
    st.qualifyingPlannedQty = planned === null ? 0 : planned;
    st.grossGapByWindow = st.cumulativeGapByWindow || {};
    if (planned === null || planned <= 0) { st.residualGapByWindow = st.grossGapByWindow; return; }
    var net = {}, anyPositive = false, changed = false;
    for (var w in st.grossGapByWindow) {
      if (!Object.prototype.hasOwnProperty.call(st.grossGapByWindow, w)) continue;
      var g = weeklyAiPlanQty_(st.grossGapByWindow[w]);
      if (g === null) { net[w] = st.grossGapByWindow[w]; continue; }   // an unreadable gap is never netted
      var v = g - planned;
      if (v < 0) v = 0;
      if (v !== g) changed = true;
      net[w] = v;
      if (v > 0) anyPositive = true;
    }
    st.residualGapByWindow = net;
    st.cumulativeGapByWindow = net;
    if (changed) report.netted_site_count++;
    if (!anyPositive) report.fully_covered_site_count++;
    if (report.by_key.length < 50) {
      report.by_key.push({ key: key, marketplace: st.marketplace, sku: st.sku,
        qualifying_planned_qty: planned, gross: st.grossGapByWindow, residual: net });
    }
  });
  return report;
}

/**
 * §C — THE DECISION. Given the recommendation state and the qualifying plan, is "generate nothing" the
 * CORRECT answer, or is it a refusal?
 *
 * It is correct in exactly two shapes, and they are reported as different reasons because they are different
 * facts an operator would act on differently:
 *   VALID_ZERO_RECOMMENDATION  — nothing is short. Nothing to do, and nothing was planned that needs review.
 *   FULLY_COVERED_BY_ACTIVE_PLAN — something IS short and the operator has already planned all of it. The AI
 *                                  has nothing to ADD, and it must not reduce, cancel or duplicate what is there.
 * Anything else, including a MISSING_RECOMMENDATION, is NOT a no-action: it is a refusal that keeps its own
 * code, because a scope nobody could read is not a scope with nothing in it.
 */
function weeklyAiPlanNoActionDecision_(recState, planned) {
  var out = { noAction: false, reason: null, code: WAP_NO_ACTION_CODE_,
    recommendation_state: recState ? recState.state : null,
    recommended_qty: recState ? recState.recommended_qty_total : null,
    qualifying_planned_qty: 0, residual_qty: null, per_scope: [] };
  if (!recState || recState.state === WAP_RECOMMENDATION_STATES_.MISSING) {
    out.reason = 'MISSING_RECOMMENDATION';
    out.missing_reasons = (recState && recState.missing_reasons) || [];
    return out;
  }
  var totalPlanned = 0, totalResidual = 0, anyResidual = false;
  (recState.per_scope || []).forEach(function (s) {
    var key = s.key;
    var p = weeklyAiPlanQty_((planned && planned.byKey) ? planned.byKey[key] : null);
    if (p === null) p = 0;
    var residual = weeklyAiPlanResidualQty_(s.recommended_qty, p);
    totalPlanned += p;
    if (residual !== null) { totalResidual += residual; if (residual > 0) anyResidual = true; }
    out.per_scope.push({ key: key, marketplace: s.marketplace, sku: s.sku,
      recommended_qty: s.recommended_qty, qualifying_planned_qty: p, residual_qty: residual,
      over_planned_qty: (s.recommended_qty !== null && p > s.recommended_qty) ? (p - s.recommended_qty) : 0 });
  });
  out.qualifying_planned_qty = totalPlanned;
  out.residual_qty = totalResidual;
  if (anyResidual) { out.reason = 'RESIDUAL_REMAINS'; return out; }
  out.noAction = true;
  out.reason = (recState.state === WAP_RECOMMENDATION_STATES_.VALID_ZERO)
    ? 'VALID_ZERO_RECOMMENDATION' : 'FULLY_COVERED_BY_ACTIVE_PLAN';
  return out;
}

/**
 * §C — the typed SUCCESS envelope for a correct no-action. Zero writes, and the writer is never reached.
 *
 * It carries the NEW formal name AND the three keys the shipped page already classifies a zero result from
 * (`code`, `zero_result`, `job_status`). A success the client cannot recognise is presented to the operator as
 * a failure, and presenting a correct finish as a failure is the whole defect.
 */
function weeklyAiPlanNoActionResponse_(decision, ctx) {
  ctx = ctx || {};
  return {
    success: true,
    data: {
      outcome: WAP_NO_ACTION_CODE_,
      code: 'NO_REPLENISHMENT_REQUIRED',
      no_action_reason: decision.reason,
      message: decision.reason === 'FULLY_COVERED_BY_ACTIVE_PLAN'
        ? 'No action required: the recommended quantity for this scope is already covered by the active'
          + ' Execution Plan. Nothing was created, changed or cancelled.'
        : 'No replenishment is required for this scope. Nothing was created, changed or cancelled.',
      recommendation_state: decision.recommendation_state,
      recommended_qty: decision.recommended_qty,
      qualifying_planned_qty: decision.qualifying_planned_qty,
      residual_qty: decision.residual_qty,
      per_scope: decision.per_scope,
      recommendation_authority: ctx.recommendation_authority || null,
      planning_cycle: ctx.planning_cycle || null,
      scope: ctx.scope || null,
      mode: ctx.mode || null,
      generation_run_id: ctx.generation_run_id || null,
      // Every mutation counter, explicitly zero. A reader must never have to infer "nothing happened" from
      // the absence of a number.
      created_headers: 0, updated_headers: 0, created_lines: 0, updated_lines: 0,
      cancelled_headers: 0, cancelled_lines: 0, expired_headers: 0, expired_lines: 0,
      header_created: false, line_created: false,
      route_count: 0, routes: [], groups: [],
      requested_qty: decision.recommended_qty, allocated_qty: 0,
      db_writes: 0, writer_reached: false,
      // The keys the shipped page's zero-result classifier reads. Kept deliberately.
      status: 'COMPLETED', zero_result: true, job_status: 'NO_DEMAND',
      site_count: ctx.site_count == null ? null : ctx.site_count,
      source_data_as_of: ctx.source_data_as_of || null
    },
    errors: []
  };
}

/**
 * F1-7N-FC-1B-E3-R4 §G — IS THIS A GROUP WITH NOTHING TO REPLENISH, OR A GROUP WE FAILED TO READ?
 *
 * KMAF is a frozen contract and it is RIGHT: when a group's total demand basis is zero there is no
 * proportional share, and it refuses to invent one (DEMAND_WEIGHT_UNRESOLVED). What was wrong was the
 * CONSEQUENCE. "Every site here needs nothing this week" was reaching the operator as a red failure
 * indistinguishable from a broken read, and the honest answer to it is zero routes.
 *
 * So the decision is made HERE, by the consumer, on the DATA — never on the error code alone, because a
 * no-demand success that can swallow a real allocator error is worse than the refusal it replaces. Every one
 * of these must hold:
 *
 *   1. There is a universe to speak about (receivers were built). An empty universe already has its own
 *      answer further up and is not this case.
 *   2. The harvest dropped NOTHING. A site we could not read is not a site that needs nothing, and
 *      `errors` is exactly the list of sites the harvest declined to carry.
 *   3. EVERY blocking issue is DEMAND_WEIGHT_UNRESOLVED. One other issue and this is a different problem.
 *   4. EVERY receiver's demand basis is a RESOLVED, finite, non-negative number. An unresolved basis is
 *      unknown, and unknown is not zero — the same rule KMFCN applies to a forecast month.
 *   5. Their total is exactly zero.
 *   6. And the CANONICAL demand agrees: no horizon anywhere in the group carries a positive gap. This is
 *      the one that matters most. The basis is the SHARE WEIGHT, not the quantity; a group whose forecast
 *      weight is zero but whose materialized Suggested Qty is positive has real demand and an unresolvable
 *      share, which is precisely the error §G says must stay an error.
 *
 * Returns { noDemand: bool, reason, receiverCount, basisTotal, gapTotal, positiveGapRefs[] }.
 */
// ================================================================================================================
// R6-R7-R2 — THE HANDLER'S ANSWER HAS ONE BUILDER, AND A DIAGNOSTIC MAY ONLY REPORT WHAT IT RETURNS.
//
// R6-R7-R1 put the no-action short circuit in the production handler and then had the preflight ask 61_'s
// classifiers directly and map their result to an outcome ITSELF. Two mappings for one decision is the same
// defect the parity check exists to catch, one level further in: they agreed on the day they were written,
// and nothing made them keep agreeing. The live run then showed it from the other side — the wrapper said
// READY_NO_ACTION while the log beside it still carried a STOP, and the export a reader would audit carried
// neither the outcome nor the parity.
//
// So the decision is built HERE, once, and the outcome and code are read back OUT OF THE ACTUAL ENVELOPES the
// handler returns — not restated next to them. A diagnostic that wants to know what production would
// answer calls this and reports its fields; it has no mapping of its own to drift.
// ================================================================================================================

/**
 * The refusal envelope, extracted so that the ONE place a REQUESTED_SCOPE_EMPTY is worded is also the place a
 * diagnostic reads its code from. It keeps `zero_write: true` and names WHY the row could not be read as a
 * valid zero, because 'produced no allocated lines' on its own is what made a correct finish and a real fault
 * indistinguishable.
 */
function weeklyAiPlanScopeEmptyRefusal_(decision, ctx) {
  ctx = ctx || {};
  return { success: false, zero_write: true,
    errors: [weeklyAiPlanErr_('REQUESTED_SCOPE_EMPTY',
      'requested marketplace produced no allocated lines: ' + weeklyAiPlanStr_(ctx.requested_marketplace)
        + ' (and the canonical recommendation could not be read as a valid zero: ' + decision.reason + ')',
      { recommendation_state: decision.recommendation_state, no_action_reason: decision.reason,
        missing_reasons: decision.missing_reasons || [], recommended_qty: decision.recommended_qty,
        qualifying_planned_qty: decision.qualifying_planned_qty, residual_qty: decision.residual_qty,
        recommendation_authority: ctx.recommendation_authority || null, db_writes: 0 })] };
}

/** The order the public handler applies these gates in, stated as data so a claim about it can be checked
 *  rather than believed. Index 0 runs first. */
var WAP_CONTROLLED_GATE_ORDER_ = [
  'FLAG_GATE',                       // staged off -> nothing runs at all
  'HARVEST_AND_CANONICAL_AUTHORITY', // the row is read; the decision below is resolved from it
  'VALID_ZERO_SHORT_CIRCUIT',        // AI_PLAN_NO_ACTION returns here, with zero writes
  'REQUESTED_SCOPE_EMPTY_REFUSAL',   // only reached when the row could NOT be read as a valid zero
  'ALLOCATOR_MARKETPLACE_FILTER',
  'PASS_2_WRITER'
];

/**
 * THE DECISION OBJECT. Everything a caller — the handler, a preflight, a test — needs in order to say what
 * this run would do, with `outcome` and `code` taken from the envelopes themselves.
 *
 * `would_write` is deliberately narrow: it is true only when there is a residual to generate. A refusal does
 * not write and neither does a no-action, and collapsing those two into 'not writing' is how a preflight ends
 * up certifying a run that cannot happen.
 */
function weeklyAiPlanControlledDecisionFromParts_(decision, ctx) {
  ctx = ctx || {};
  var out = {
    available: true, unavailable_reason: null,
    // The PUBLIC entry point, named as the router actually binds it. 'the AI Plan handler' is not an address;
    // a reader has to be able to find the same door this decision was resolved behind.
    entry_point: 'KM.DB.generateWeeklyAiPlanDraft -> POST action=weeklyAiPlan.generate (01_router.gs)'
      + ' -> handleGenerateWeeklyAiPlanDraft_ -> weeklyAiPlanGenerateK2_ (61_)',
    decision_source: 'weeklyAiPlanControlledDecisionFromParts_ (61_) — the same builder the handler'
      + ' returns its envelope from; a caller reports these fields and maps nothing itself',
    outcome: null, code: null, reason: decision ? decision.reason : null,
    recommendation_state: decision ? decision.recommendation_state : null,
    recommended_qty: decision ? decision.recommended_qty : null,
    qualifying_active_planned_qty: decision ? decision.qualifying_planned_qty : null,
    // the historical field name, kept so an existing reader does not silently read undefined
    qualifying_planned_qty: decision ? decision.qualifying_planned_qty : null,
    residual_qty: decision ? decision.residual_qty : null,
    per_scope: (decision && decision.per_scope) || [],
    missing_reasons: (decision && decision.missing_reasons) || [],
    would_write: false, writer_reached: false, db_writes: 0,
    requested_scope_empty_is_bypassed_by_valid_zero: false,
    gate_order: WAP_CONTROLLED_GATE_ORDER_.slice(),
    response: null, refusal: null
  };
  if (!decision) {
    out.available = false;
    out.unavailable_reason = 'NO_DECISION: the canonical authority produced nothing to report';
    return out;
  }
  if (decision.noAction) {
    out.response = weeklyAiPlanNoActionResponse_(decision, ctx);
    out.outcome = out.response.data.outcome;
    out.code = out.response.data.code;
    out.writer_reached = out.response.data.writer_reached === true;
    out.db_writes = out.response.data.db_writes;
    // The short circuit is ordered BEFORE the refusal (see WAP_CONTROLLED_GATE_ORDER_), so when the requested
    // marketplace allocates nothing this answers first and REQUESTED_SCOPE_EMPTY never fires.
    out.requested_scope_empty_is_bypassed_by_valid_zero = true;
    return out;
  }
  if (decision.recommendation_state === WAP_RECOMMENDATION_STATES_.MISSING) {
    out.refusal = weeklyAiPlanScopeEmptyRefusal_(decision, ctx);
    out.outcome = 'REFUSAL';
    out.code = out.refusal.errors[0].code;
    return out;
  }
  out.outcome = 'WOULD_GENERATE';
  out.would_write = weeklyAiPlanQty_(decision.residual_qty) > 0;
  return out;
}

/**
 * The same decision, resolved from the database for a caller that has no harvest — a preflight. It reads
 * through 61_'s OWN canonical reader, target-scope guard, state classifier and qualifying-plan reader: the
 * functions the harvest itself calls, so this is the production answer and not a reconstruction of it.
 *
 * READ-ONLY by construction. No writer is built, KMWRB/KMWRR are not called, and nothing here reaches PASS 2.
 */
function weeklyAiPlanControlledDecision_(ss, scope, requestedMarketplace, calcDate) {
  var canonical, target, recState, planned, decision;
  try {
    canonical = weeklyAiPlanCanonicalDemand_(ss, scope, calcDate || null);
    target = weeklyAiPlanTargetScopes_(scope, requestedMarketplace
      || (scope && scope.marketplace) || '');
    recState = weeklyAiPlanRecommendationState_(canonical, target);
    planned = weeklyAiPlanQualifyingPlannedQty_(ss, scope);
    decision = weeklyAiPlanNoActionDecision_(recState, planned);
  } catch (e) {
    return { available: false, unavailable_reason: 'PRODUCTION_AUTHORITY_THREW: '
      + weeklyAiPlanStr_(e && e.message), outcome: null, code: null, reason: null,
      recommendation_state: null, recommended_qty: null, qualifying_active_planned_qty: null,
      qualifying_planned_qty: null, residual_qty: null, per_scope: [], would_write: false,
      writer_reached: false, db_writes: 0, requested_scope_empty_is_bypassed_by_valid_zero: false,
      gate_order: WAP_CONTROLLED_GATE_ORDER_.slice(), response: null, refusal: null };
  }
  var out = weeklyAiPlanControlledDecisionFromParts_(decision, {
    planning_cycle: scope && scope.planningCycle, scope: scope,
    requested_marketplace: requestedMarketplace || (scope && scope.marketplace) || '',
    recommendation_authority: recState });
  out.authority = { rule: recState.authority_rule,
    accepted_calculation_date: recState.accepted_calculation_date,
    current_run: recState.current_run, per_scope: recState.per_scope,
    qualification: planned.authority, planned_rows: planned.rows,
    planned_excluded: planned.excluded, provenance_authority: planned.provenance_authority };
  return out;
}

function weeklyAiPlanNoDemandVerdict_(h, mapped) {
  var out = { noDemand: false, reason: null, receiverCount: 0, basisTotal: 0, gapTotal: 0, positiveGapRefs: [] };
  var kmaf = (h && h.kmaf) || {};
  var receivers = Array.isArray(h && h.builtReceivers) ? h.builtReceivers : [];
  out.receiverCount = receivers.length;
  if (!receivers.length) { out.reason = 'NO_RECEIVERS_BUILT'; return out; }
  if (Array.isArray(h.errors) && h.errors.length) { out.reason = 'HARVEST_DROPPED_SITES'; return out; }

  // (3) every blocking issue is the zero-total one, from BOTH layers.
  var issues = (Array.isArray(kmaf.issues) ? kmaf.issues : [])
    .concat(Array.isArray(mapped && mapped.issues) ? mapped.issues : []);
  var blocking = issues.filter(function (i) { return i && i.blocking !== false; });
  if (!blocking.length) { out.reason = 'NOT_A_DEMAND_WEIGHT_REFUSAL'; return out; }
  // READ THE ENGINE CODE, NOT THE MAPPED ONE. KMWHA maps DEMAND_WEIGHT_UNRESOLVED to the readiness code
  // SUGGESTED_QTY_UNRESOLVED — and so does DAILY_DEMAND_UNRESOLVED, WEIGHT_BASIS_UNRESOLVED,
  // MISSING_FORECAST_WEIGHT_SOURCE and FORECAST_BASIS_UNRESOLVED. Matching on the mapped code would accept
  // five different faults as "this group needs nothing", which is precisely the swallow §G forbids. The
  // mapper preserves `engine_code`; an issue that carries neither an engine code nor a recognizable engine
  // code of its own is not understood, and what is not understood does not become a success.
  for (var i = 0; i < blocking.length; i++) {
    var eng = weeklyAiPlanStr_(blocking[i].engine_code) || weeklyAiPlanStr_(blocking[i].code);
    if (eng !== 'DEMAND_WEIGHT_UNRESOLVED') { out.reason = 'OTHER_BLOCKING_ISSUE:' + (eng || 'UNNAMED'); return out; }
  }

  // (4)+(5) every basis resolved, finite, non-negative, and summing to exactly zero.
  for (var r = 0; r < receivers.length; r++) {
    var fb = receivers[r] && receivers[r].forecastBasis;
    var b = fb ? fb.forecastShareQty : undefined;
    if (typeof b !== 'number' || !isFinite(b) || b < 0) { out.reason = 'BASIS_UNRESOLVED'; return out; }
    out.basisTotal += b;
  }
  if (out.basisTotal !== 0) { out.reason = 'BASIS_TOTAL_NONZERO'; return out; }

  // (6) the CANONICAL demand must agree. A positive gap anywhere means this group is not empty.
  var horizons = (h && h.horizonsByDemandRef) || {};
  for (var ref in horizons) {
    if (!Object.prototype.hasOwnProperty.call(horizons, ref)) continue;
    var byWin = (horizons[ref] && horizons[ref].cumulativeGapByWindow) || {};
    for (var w in byWin) {
      if (!Object.prototype.hasOwnProperty.call(byWin, w)) continue;
      var q = Number(byWin[w]);
      if (!isFinite(q)) { out.reason = 'CANONICAL_DEMAND_UNRESOLVED'; return out; }
      if (q > 0) { out.gapTotal += q; if (out.positiveGapRefs.indexOf(ref) === -1) out.positiveGapRefs.push(ref); }
    }
  }
  if (out.positiveGapRefs.length) { out.reason = 'POSITIVE_CANONICAL_DEMAND_WITH_UNRESOLVED_WEIGHT'; return out; }

  out.noDemand = true;
  out.reason = 'NO_REPLENISHMENT_REQUIRED';
  return out;
}

/**
 * Build real persistence deps (KMPR repository + KMPL LockService apply) for WEEKLY_SHIPPING — a faithful mirror of
 * 24_ rpoGenerateRecommendationDraftLockedResult_, only with type fixed to WEEKLY_SHIPPING.
 */
function weeklyAiPlanPersistenceDeps_(ss) {
  var type = 'WEEKLY_SHIPPING';
  var cfg = KMPR.TABLES[type], tables = [cfg.header, cfg.lines, KMPR.RUN_JOURNAL_TABLE];
  return {
    loadActiveContext: function (q) { var b = rprBuildSheetSet_(ss, [cfg.header]); return KMPR.loadActiveDraftContext(b.set, q); },
    loadPriorSnapshot: function (id) { var b = rprBuildSheetSet_(ss, tables); return KMPR.loadDraftSnapshot(b.set, id, type); },
    lockedApply: function (plan, expectedToken, opts) {
      var lock = LockService.getScriptLock();
      var d2 = {
        validatePlan: function (p) { return KMPR.validatePersistencePlan(p); },
        acquireLock: function () { return lock.tryLock(30000); },
        releaseLock: function () { lock.releaseLock(); },
        loadActiveDraftContext: function () { var b = rprBuildSheetSet_(ss, [cfg.header]); return KMPR.loadActiveDraftContext(b.set, { recommendationType: type, planningCycle: plan.planningCycle, businessScope: plan.businessScope }); },
        reloadSnapshot: function () { d2._built = rprBuildSheetSet_(ss, tables); return KMPR.loadDraftSnapshot(d2._built.set, plan.draftId, type); },
        recomputeToken: function (snap) {
          var dv = snap.draft ? snap.draft.draft_version : plan.draftVersion;
          return KMPR.computeExpectedToken(dv, (snap.lines || []).map(function (l) { return { lineKey: l.lineKey, userQty: l.userQty, userEdited: l.userEdited }; }));
        },
        applyPlan: function (tok, o) {
          var built = d2._built, before = {};
          for (var i = 0; i < tables.length; i++) before[tables[i]] = built.set[tables[i]].rows.map(function (r) { return r.slice(); });
          var resR = KMPR.applyPersistencePlan(built.set, plan, tok, o || opts || {});
          if (!resR.conflict && resR.runStatus !== 'FAILED') { rpoKeyedDeltaWrite_(built.meta, built.set, before, tables); }
          return resR;
        }
      };
      return KMPL.executeLockedPersistence({ plan: plan, expectedToken: expectedToken, opts: opts, generationType: opts.generationType, deps: d2 });
    }
  };
}

/**
 * Enumerate all (marketplace, sku, destination) shipping sites for the (company,country) universe, each with per-window
 * horizons, via the recommendation workspace (per marketplace). BOTH destination topologies are included via the frozen
 * canonical destination authority (F1-7N-D-2c): WAREHOUSE lines carry warehouse_id (self_fulfilled/3PL); MARKETPLACE
 * lines carry the LOGICAL marketplace_id destination (platform_fulfilled/FBA) — resolved by KMWHA.resolveWorkspaceLineDestination
 * (reuses KMDR). Only lines with NO resolved canonical destination (DESTINATION_AUTHORITY_UNRESOLVED) are skipped.
 * LIVE-VERIFY (Apps-Script-runtime only).
 */
/**
 * F1-7N-FC-1B-E3-R4 §E — THE EXECUTION DEMAND SNAPSHOT, AND WHY IT HAD TO CHANGE.
 *
 * The screen's Suggested Qty is a MATERIALIZED row: 43_ writes inventory_replenishment_gap and the page reads
 * d90_suggested_qty out of it. The AI Plan was reading something else. It calls the recommendation workspace
 * (42_), and 42_ is NOT a read facade over that table — it RECOMPUTES, live, through the frozen KMHP horizon
 * owner. Same engine, two evaluations at two different moments, and nothing compared them.
 *
 * For one round that difference was invisible because both sides agreed. It is not a property of the system
 * that they will: the snapshot is by definition older than the live recomputation, and any input that moved in
 * between — a shipment received, a forecast edited, a snapshot re-imported — separates them. The operator
 * approves 520 on the screen and the plan allocates whatever the engine says at generation time.
 *
 * So the authority is now stated instead of assumed. THE MATERIALIZED ROW IS THE DEMAND. The live workspace
 * still supplies STRUCTURE — which destinations exist, which windows a site has, what date each window is
 * required by — because none of that is a quantity. Every QUANTITY comes from the snapshot.
 *
 * This is a read gate of the same shape KMFCN uses for the forecast, and for the same reason: a zero is only
 * honest when the system looked. A missing table, a missing header, an absent row, a BLOCKED calculation or a
 * snapshot computed for a different planning date are all UNKNOWN, and unknown never becomes a quantity.
 *
 * Returns { ok, reason, bySite: { 'company|country|marketplace|sku': {...} }, rowCount, lineage }.
 */
var WAP_GAP_TABLE_ = 'inventory_replenishment_gap';
var WAP_GAP_REQUIRED_COLS_ = ['company', 'country', 'marketplace', 'sku', 'calculation_status', 'calculation_date',
  'd18_suggested_qty', 'd30_suggested_qty', 'd45_suggested_qty', 'd90_suggested_qty'];
var WAP_GAP_WINDOW_COL_ = { D18: 'd18_suggested_qty', D30: 'd30_suggested_qty', D45: 'd45_suggested_qty', D90: 'd90_suggested_qty' };

/**
 * F1-7N-FC-1B-E3-R4-A2-R1 §3 — READ THE SCHEDULE THIS DEPLOYMENT ACTUALLY RUNS ON.
 *
 * Not a constant. 45_ owns the automation configuration and a deployment can change its own hours, so the
 * freshness rule reads the EFFECTIVE config for the Inventory Gap job and falls back to the declared default
 * only when the stored config cannot be read. Hard-coding 13:30 here would make the rule silently wrong for
 * any deployment that moved it, which is the same class of mistake as hard-coding today's date.
 */
function weeklyAiPlanGapSchedule_() {
  var out = { hour: 13, minute: 30, enabled: true, source: 'DECLARED_DEFAULT',
    driftMinutes: 15, completionBudgetMinutes: 240 };
  try {
    if (typeof AUTOMATION_JOBS_ !== 'undefined' && AUTOMATION_JOBS_) {
      for (var i = 0; i < AUTOMATION_JOBS_.length; i++) {
        if (AUTOMATION_JOBS_[i].key === 'inventoryGap' && AUTOMATION_JOBS_[i].defaults) {
          out.hour = AUTOMATION_JOBS_[i].defaults.hour;
          out.minute = AUTOMATION_JOBS_[i].defaults.minute;
          out.enabled = AUTOMATION_JOBS_[i].defaults.enabled === true;
        }
      }
    }
    // The STORED config wins over the declared default when it exists.
    if (typeof automationReadConfig_ === 'function' && typeof automationDefaultIo_ === 'function') {
      var cfg = automationReadConfig_(automationDefaultIo_());
      var c = cfg && cfg.inventoryGap;
      if (c && typeof c.hour === 'number' && typeof c.minute === 'number') {
        out.hour = c.hour; out.minute = c.minute; out.enabled = c.enabled === true;
        out.source = 'EFFECTIVE_CONFIG';
      }
    }
  } catch (e) { out.source = 'DECLARED_DEFAULT_AFTER_ERROR'; }
  return out;
}

/**
 * §3 — the Inventory Gap job's own account of itself, when it can be read. CORROBORATION ONLY: a job
 * reporting FAILED is evidence, and a job reporting nothing is not evidence of success.
 */
function weeklyAiPlanGapJobState_() {
  try {
    if (typeof GAP_JOB_PROP_KEYS_ === 'undefined') return null;
    var raw = PropertiesService.getScriptProperties().getProperty(GAP_JOB_PROP_KEYS_.INVENTORY);
    if (!raw) return null;
    var st = JSON.parse(raw);
    if (!st) return null;
    // §3 — THE STORED STAMP IS ALREADY A TAIPEI WALL-CLOCK STRING, so it is READ, not re-interpreted.
    //
    // My first version did `new Date(st.startedAt).getTime()`, which is wrong twice over. It constructs a Date
    // from a string whose zone is implicit, so the runtime would resolve "2026-09-04 09:00:00" against the
    // SERVER's zone rather than Asia/Taipei and could land on the wrong business day — the exact class of
    // mistake this feature has been correcting all round. And it constructs a date object inside 61_, which the
    // E3-R1 no-fabricated-timestamp guard forbids for good reason.
    //
    // The business DATE is all this needs, and the first ten characters of the stamp already are it.
    var startedDate = weeklyAiPlanStr_(st.startedAt).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startedDate)) startedDate = null;
    return { status: weeklyAiPlanStr_(st.status), runId: weeklyAiPlanStr_(st.runId),
      startedAtDate: startedDate, startedAt: weeklyAiPlanStr_(st.startedAt) || null,
      scopesProcessed: st.scopesProcessed, scopesTotal: st.scopesTotal, product: 'INVENTORY' };
  } catch (e) { return null; }
}

/**
 * F1-7N-FC-1B-E3-R4-A2-R1-R1 §2 — THE SNAPSHOT DATE, CANONICALIZED AT THE ONE BOUNDARY IT CROSSES.
 *
 * `calculation_date` is a DATE-FORMATTED CELL, so getValues() returns a Date OBJECT and not the text shown in
 * the sheet. Every value below this line used to arrive through the generic `weeklyAiPlanStr_`, which is
 * String() + trim() — correct for a text column and catastrophic for this one: a healthy row became
 * "Thu Sep 03 2026 00:00:00 GMT+0800 (Taiwan Standard Time)", failed the YYYY-MM-DD test in the freshness
 * authority, and was reported as LINEAGE_MISMATCH. That code means "this snapshot came from another run"; the
 * data was fine and the reader was the fault.
 *
 * The conversion is KMSNF's, so production, the Census and every test resolve a cell the SAME way — a second
 * local rule here is how the two would drift back apart. The offset is the planning zone's authority and is
 * REQUIRED: with no zone there is no business day, and a guessed one lands on the wrong side of midnight.
 */
function weeklyAiPlanCanonicalDate_(v) {
  if (typeof KMSNF === 'undefined' || !KMSNF || typeof KMSNF.canonicalDate !== 'function') {
    return { ok: false, date: null, kind: 'UNKNOWN', reason: 'SNAPSHOT_DATE_AUTHORITY_UNAVAILABLE' };
  }
  if (typeof GAP_CALC_UTC_OFFSET_MIN_ === 'undefined') {
    return { ok: false, date: null, kind: 'UNKNOWN', reason: 'TIMEZONE_AUTHORITY_UNAVAILABLE' };
  }
  return KMSNF.canonicalDate(v, GAP_CALC_UTC_OFFSET_MIN_);
}

function weeklyAiPlanCanonicalDemand_(ss, scope, calcDate) {
  var out = { ok: false, reason: null, bySite: {}, byKeyDate: {}, dateIndex: {}, distinctDates: [],
    rowCount: 0, calculationDate: calcDate || null, acceptedDate: null, freshness: null,
    freshnessState: null, schedule: null, jobState: null,
    // §10 — how the date column was actually read, so "a Date object arrived and we handled it" and "a
    // string arrived" are distinguishable in a diagnostic instead of both looking like a bare date.
    dateNormalization: { by_kind: {}, unreadable: 0, unreadable_sample: [],
      offset_minutes: (typeof GAP_CALC_UTC_OFFSET_MIN_ !== 'undefined') ? GAP_CALC_UTC_OFFSET_MIN_ : null } };
  var sh;
  try { sh = ss.getSheetByName(WAP_GAP_TABLE_); }
  catch (e) { out.reason = 'CANONICAL_DEMAND_READ_FAILED'; return out; }
  // A MISSING table and an EMPTY one mean opposite things, and gapReadObjects_ returns [] for both. Ask the
  // sheet directly, or a deployment fault becomes a plan for nothing.
  if (!sh) { out.reason = 'CANONICAL_DEMAND_TABLE_MISSING'; return out; }
  var headers;
  try { headers = (sh.getLastRow() > 0) ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return weeklyAiPlanStr_(h); }) : []; }
  catch (e2) { out.reason = 'CANONICAL_DEMAND_READ_FAILED'; return out; }
  for (var c = 0; c < WAP_GAP_REQUIRED_COLS_.length; c++) {
    if (headers.indexOf(WAP_GAP_REQUIRED_COLS_[c]) === -1) {
      out.reason = 'CANONICAL_DEMAND_HEADER_MISSING:' + WAP_GAP_REQUIRED_COLS_[c];
      return out;
    }
  }
  var rows = (typeof gapReadObjects_ === 'function') ? (gapReadObjects_(ss, WAP_GAP_TABLE_) || []) : [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (weeklyAiPlanStr_(r.company) !== scope.company || weeklyAiPlanStr_(r.country) !== scope.country) continue;
    var key = weeklyAiPlanStr_(r.company) + '|' + weeklyAiPlanStr_(r.country) + '|'
      + weeklyAiPlanStr_(r.marketplace) + '|' + weeklyAiPlanStr_(r.sku);
    var rec = {
      company: weeklyAiPlanStr_(r.company), country: weeklyAiPlanStr_(r.country),
      marketplace: weeklyAiPlanStr_(r.marketplace), sku: weeklyAiPlanStr_(r.sku),
      calculation_status: weeklyAiPlanStr_(r.calculation_status),
      // §2 — NOT weeklyAiPlanStr_. See weeklyAiPlanCanonicalDate_ above: this column is a Date object.
      calculation_date: '',
      calculated_at: weeklyAiPlanStr_(r.calculated_at), updated_at: weeklyAiPlanStr_(r.updated_at),
      note: weeklyAiPlanStr_(r.note), source_table: WAP_GAP_TABLE_, suggestedByWindow: {}, duplicate: false
    };
    // §2 — resolved BEFORE the record is keyed, because the date is half of every key below. A value that
    // cannot be resolved keeps its raw rendering so the downstream block still fires and still NAMES it; what
    // changes is that a Date object is no longer one of those values.
    var _cd = weeklyAiPlanCanonicalDate_(r.calculation_date);
    rec.calculation_date = _cd.ok ? _cd.date : weeklyAiPlanStr_(r.calculation_date);
    rec.calculation_date_kind = _cd.kind;
    out.dateNormalization.by_kind[_cd.kind] = (out.dateNormalization.by_kind[_cd.kind] || 0) + 1;
    if (!_cd.ok) {
      out.dateNormalization.unreadable++;
      out.dateNormalization.unreadable_sample.push({ key: key, kind: _cd.kind, reason: _cd.reason,
        raw: weeklyAiPlanStr_(r.calculation_date).slice(0, 60) });
    }
    for (var w in WAP_GAP_WINDOW_COL_) {
      if (!Object.prototype.hasOwnProperty.call(WAP_GAP_WINDOW_COL_, w)) continue;
      var raw = r[WAP_GAP_WINDOW_COL_[w]];
      var v = (raw === '' || raw === null || raw === undefined) ? null : Number(raw);
      rec.suggestedByWindow[w] = (v !== null && isFinite(v)) ? v : null;
    }
    // §3 — every row is kept, KEYED BY (site, calculation_date). R4 collapsed the table to one row per
    // site and then compared that row's date to today, which is how a complete 2026-09-03 snapshot came to be
    // reported as STALE at 10:41 on 2026-09-04 — three hours before today's run is even due. The dates are
    // now collected first and the SCHEDULE decides which one is current.
    var dk = key + '@' + rec.calculation_date;
    if (out.byKeyDate[dk]) { out.byKeyDate[dk].duplicate = true; continue; }
    out.byKeyDate[dk] = rec;
    if (!out.dateIndex[rec.calculation_date]) {
      out.dateIndex[rec.calculation_date] = { date: rec.calculation_date, status: rec.calculation_status,
        rowCount: 0, planningCycle: 'RECO-' + rec.calculation_date.slice(0, 7) };
    }
    out.dateIndex[rec.calculation_date].rowCount++;
    // ONE BLOCKED SITE DOES NOT POISON THE RUN. My first version carried the WORST status seen forward, which
    // meant a single BLOCKED SKU made the whole date "not a complete snapshot" and refused every other site on
    // it — the opposite of what the comment beside it claimed, and a much broader block than intended. A run
    // that produced usable rows IS a run; the per-site gate below is what refuses the blocked site, by itself.
    // A date is only NO_COMPLETE_SNAPSHOT when NOTHING on it is READY.
    if (rec.calculation_status === 'READY') out.dateIndex[rec.calculation_date].status = 'READY';
    else if (out.dateIndex[rec.calculation_date].status !== 'READY') {
      out.dateIndex[rec.calculation_date].status = rec.calculation_status;
    }
    out.rowCount++;
  }

  // ---- §3 THE FRESHNESS DECISION, and it is about the SCHEDULE, not the calendar --------------------------
  var dates = [];
  for (var dkey in out.dateIndex) { if (Object.prototype.hasOwnProperty.call(out.dateIndex, dkey)) dates.push(out.dateIndex[dkey]); }
  out.distinctDates = dates.map(function (d) { return d.date; }).sort();
  if (typeof KMSNF === 'undefined' || !KMSNF || typeof KMSNF.assess !== 'function') {
    out.reason = 'SNAPSHOT_FRESHNESS_AUTHORITY_UNAVAILABLE';
    return out;
  }
  // Only the LATEST date is offered to the authority. Older complete runs are history, not candidates, and
  // offering two would make "mixed rows" indistinguishable from "we kept last week's as well".
  var latest = out.distinctDates.length ? out.distinctDates[out.distinctDates.length - 1] : null;
  // But a scope carrying rows from MORE THAN ONE date is exactly the partial-write case, and the authority has
  // to see both to say so. 43_ upserts row by row with no atomic publication, so this is the only observable
  // form a half-finished run takes.
  var offered = dates.filter(function (d) { return d.date === latest || out.distinctDates.length > 1; });
  out.schedule = weeklyAiPlanGapSchedule_();
  out.jobState = weeklyAiPlanGapJobState_();
  // §3 — THE CLOCK HAS EXACTLY ONE OWNER, and if it is absent this refuses rather than inventing one.
  //
  // My first version fell back to constructing a clock here. That is precisely the fabrication the E3-R1
  // no-fabricated-timestamp guard exists to prevent, and it would have been worse than a refusal: a
  // deployment missing the canonical planning-context owner would have silently planned against a clock
  // nobody governs, in whatever zone the runtime happened to be in.
  if (typeof gapCalcNowMs_ !== 'function') {
    out.reason = 'PLANNING_CLOCK_AUTHORITY_UNAVAILABLE';
    return out;
  }
  var fresh = KMSNF.assess({
    nowMs: gapCalcNowMs_(),
    utcOffsetMinutes: (typeof GAP_CALC_UTC_OFFSET_MIN_ !== 'undefined') ? GAP_CALC_UTC_OFFSET_MIN_ : 480,
    schedule: out.schedule,
    snapshotDates: offered,
    expectedPlanningCycle: scope.planningCycle,
    jobState: out.jobState
  });
  out.freshness = fresh;
  out.freshnessState = fresh.state;
  if (!fresh.ok) { out.reason = fresh.state; return out; }
  out.acceptedDate = fresh.acceptedDate;
  // The accepted date, and ONLY it, becomes the site map. Nothing from another run can reach the allocator.
  for (var k2 in out.byKeyDate) {
    if (!Object.prototype.hasOwnProperty.call(out.byKeyDate, k2)) continue;
    var r2 = out.byKeyDate[k2];
    if (r2.calculation_date !== out.acceptedDate) continue;
    var sk = r2.company + '|' + r2.country + '|' + r2.marketplace + '|' + r2.sku;
    if (out.bySite[sk] && out.bySite[sk] !== r2) { out.bySite[sk].duplicate = true; continue; }
    out.bySite[sk] = r2;
  }
  out.ok = true;
  return out;
}

/**
 * §E — accept or refuse ONE site's canonical demand. Typed, and never silently picks a side.
 * Returns { ok, code, lineage, suggestedByWindow } .
 */
function weeklyAiPlanAcceptCanonicalDemand_(snapshot, site, scope, calcDate, expectedBySite) {
  // §4 — the run the SCHEDULE selected, not the calendar date this process happens to be running on.
  var acceptedDate = (snapshot && snapshot.acceptedDate) || null;
  var key = scope.company + '|' + scope.country + '|' + site.marketplace + '|' + site.sku;
  var rec = snapshot.bySite[key];
  if (!rec) return { ok: false, code: 'CANONICAL_DEMAND_ROW_MISSING', key: key };
  if (rec.duplicate) return { ok: false, code: 'CANONICAL_DEMAND_DUPLICATE_ROWS', key: key };
  if (rec.calculation_status !== 'READY') {
    return { ok: false, code: 'CANONICAL_DEMAND_NOT_READY', key: key,
      status: rec.calculation_status || '(blank)', note: rec.note || null };
  }
  // F1-7N-FC-1B-E3-R4-A2-R1 §4 — THE DATE COMPARISON IS GONE, AND IT WAS THE DEFECT.
  //
  // R4 compared this row's calculation_date to TODAY and called any difference STALE. The Inventory Gap
  // materialization is a daily 13:30 Asia/Taipei automation, so that rule declared every scope in the database
  // stale from midnight until the afternoon — and at 10:41 on 2026-09-04 it refused a complete, successful
  // 2026-09-03 snapshot, which was the newest thing that had ever existed.
  //
  // Which date is CURRENT is now decided once, for the whole scope, by KMSNF against the real schedule, and the
  // caller has already narrowed `bySite` to the accepted run. What remains here is the check that the row
  // actually belongs to that run — a genuine lineage assertion rather than a comparison with a wall clock.
  if (acceptedDate && rec.calculation_date && rec.calculation_date !== acceptedDate) {
    return { ok: false, code: 'CANONICAL_DEMAND_LINEAGE_MISMATCH', key: key,
      snapshotDate: rec.calculation_date, acceptedDate: acceptedDate };
  }
  if (!rec.calculation_date) return { ok: false, code: 'CANONICAL_DEMAND_LINEAGE_MISSING', key: key };
  // Every window this site actually has must carry a resolved quantity.
  var out = {};
  for (var w in site.cumulativeGapByWindow) {
    if (!Object.prototype.hasOwnProperty.call(site.cumulativeGapByWindow, w)) continue;
    var v = rec.suggestedByWindow[w];
    if (v === null || v === undefined) return { ok: false, code: 'CANONICAL_DEMAND_WINDOW_UNRESOLVED', key: key, window: w };
    if (v < 0) return { ok: false, code: 'CANONICAL_DEMAND_INVALID', key: key, window: w, value: v };
    out[w] = v;
  }
  // §E.8 — the CLIENT's expectation, when it sent one. A mismatch is a CONFLICT and neither side wins:
  // the screen the operator approved and the row the server holds disagree, and allocating either one would
  // be allocating a number nobody has seen together.
  if (expectedBySite && Object.prototype.hasOwnProperty.call(expectedBySite, key)) {
    var exp = expectedBySite[key];
    for (var w2 in exp) {
      if (!Object.prototype.hasOwnProperty.call(exp, w2)) continue;
      var e = Number(exp[w2]);
      if (!isFinite(e)) return { ok: false, code: 'EXPECTED_DEMAND_INVALID', key: key, window: w2 };
      if (out[w2] !== undefined && out[w2] !== e) {
        return { ok: false, code: 'EXPECTED_DEMAND_CONFLICT', key: key, window: w2, expected: e, canonical: out[w2] };
      }
    }
  }
  return { ok: true, suggestedByWindow: out, lineage: {
    company: rec.company, country: rec.country, marketplace: rec.marketplace, sku: rec.sku,
    planning_cycle: scope.planningCycle, calculation_status: rec.calculation_status,
    calculation_date: rec.calculation_date, calculated_at: rec.calculated_at || null,
    updated_at: rec.updated_at || null, source_table: rec.source_table, source_reason: 'MATERIALIZED_SNAPSHOT',
    // §3 — WHY this run was the current one, carried with the quantity. "Accepted a snapshot dated
    // yesterday" is only defensible if the reason travels with it.
    freshness_state: (snapshot && snapshot.freshnessState) || null,
    accepted_snapshot_date: acceptedDate,
    schedule_source: (snapshot && snapshot.schedule && snapshot.schedule.source) || null,
    gap_run_id: (snapshot && snapshot.jobState && snapshot.jobState.runId) || null } };
}

function weeklyAiPlanEnumerateSites_(ss, scope, upcBySku, errors, canonical, expectedBySite) {
  var sites = [];
  var calcMonth = weeklyAiPlanStr_(scope.planningCycle).slice(5); // RECO-YYYY-MM → YYYY-MM
  var calcCtx = (typeof gapCalcResolveContext_ === 'function') ? gapCalcResolveContext_('INVENTORY') : null;
  var calcDate = (calcCtx && calcCtx.ok) ? calcCtx.calculationDate : (calcMonth + '-01');
  // io bound to THIS ss + resolved calc context (default io would open its own DB + need Script Properties).
  var io = {
    now: function () { return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; },
    nextSeq: function () { return 0; },
    configMonth: function () { return calcMonth; },
    configDate: function () { return calcDate; },
    openTarget: function () { return ss; }
  };

  // Distinct marketplaces for the scope + the per-(marketplace,sku) join fields not on the workspace line.
  var scopes = (typeof gapEnumerateScopes_ === 'function') ? gapEnumerateScopes_(ss) : [];
  var marketplaces = {}, mList = [];
  scopes.forEach(function (s) { if (weeklyAiPlanStr_(s.company) === scope.company && weeklyAiPlanStr_(s.country) === scope.country) { var m = weeklyAiPlanStr_(s.marketplace); if (m && !marketplaces[m]) { marketplaces[m] = 1; mList.push(m); } } });
  if (!mList.length) return sites;

  var mkts = (typeof gapReadObjects_ === 'function') ? gapReadObjects_(ss, 'marketplaces') : [];
  var prByMkt = {}; mkts.forEach(function (r) { prByMkt[weeklyAiPlanStr_(r.marketplace)] = r.allocation_priority; });

  for (var mi = 0; mi < mList.length; mi++) {
    var marketplace = mList[mi];
    var page = 1, totalPages = 1;
    do {
      var resp;
      try { resp = handleRecommendationWorkspaceGet_({ payload: { scope: { company: scope.company, country: scope.country, marketplace: marketplace }, pagination: { page: page, size: 100 } } }, io); }
      catch (e) { errors.push(weeklyAiPlanErr_('WORKSPACE_THREW', (e && e.message) ? String(e.message) : String(e), { marketplace: marketplace })); break; }
      if (!resp || !resp.success || !resp.data) { errors.push(weeklyAiPlanErr_('WORKSPACE_NOT_OK', 'recommendation workspace not ok', { marketplace: marketplace, errors: resp && resp.errors })); break; }
      var lines = resp.data.lines || [];
      var pg = resp.data.pagination || {}; totalPages = pg.totalPages || 1;
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        // Canonical ALLOCATION destination reference (F1-7N-D-2c): WAREHOUSE → warehouse_id (self_fulfilled/3PL,
        // unchanged); MARKETPLACE → marketplace_id (platform_fulfilled/FBA LOGICAL node — never a fabricated Amazon
        // warehouse; final Amazon FC stays downstream). PURE, Node-verified resolver (KMWHA) reusing the frozen KMDR
        // classification; fail-closed skip when the line has no resolved canonical destination.
        var d = KMWHA.resolveWorkspaceLineDestination(line);
        var dest = weeklyAiPlanStr_(d.destinationRef);
        if (!dest) continue; // DESTINATION_AUTHORITY_UNRESOLVED — no canonical destination
        if (!Array.isArray(line.horizons) || !line.horizons.length) continue; // no per-window shortage structure
        var cum = {}, reqBy = {};
        // STRUCTURE from the live workspace: which windows this site has, and when each is required by.
        // Those are not quantities and the snapshot does not carry them.
        line.horizons.forEach(function (h) { var wc = weeklyAiPlanStr_(h.windowCode); if (wc) { cum[wc] = h.gapQty; reqBy[wc] = h.requiredByDate; } });
        var _site = {
          marketplace: marketplace, sku: weeklyAiPlanStr_(line.sku), siteSku: weeklyAiPlanStr_(line.siteSku),
          destinationWarehouseId: dest, destinationType: d.destinationType, cumulativeGapByWindow: cum, requiredByByWindow: reqBy,
          fulfillmentModel: weeklyAiPlanStr_(line.fulfillmentModel), allocationPriority: prByMkt[marketplace],
          unitsPerCarton: (upcBySku || {})[weeklyAiPlanStr_(line.sku)], sourceDataAsOf: line.sourceDataAsOf || null
        };
        // §E — QUANTITY from the materialized snapshot, or this site does not enter the plan. The live
        // number is kept beside it as `liveGapByWindow` for diagnosis; nothing allocates from it.
        if (canonical) {
          var _acc = weeklyAiPlanAcceptCanonicalDemand_(canonical, _site, scope, canonical.calculationDate, expectedBySite);
          if (!_acc.ok) {
            errors.push(weeklyAiPlanErr_(_acc.code, 'canonical demand snapshot refused for ' + _acc.key,
              { marketplace: marketplace, sku: _site.sku, detail: _acc }));
            continue;
          }
          _site.liveGapByWindow = cum;
          _site.cumulativeGapByWindow = _acc.suggestedByWindow;
          _site.demandLineage = _acc.lineage;
        }
        sites.push(_site);
      }
      page++;
    } while (page <= totalPages);
  }
  return sites;
}

/**
 * Build ONE multi-site FORECAST_DRIVEN KMAF receiver set (so §7 demandWeight normalizes once across the whole
 * (company,country) universe) + the matching horizon rows keyed by the SAME demandRef. §7 basis = forecastShareQty =
 * Σ Regular FC over M+1..M+4 (reused via recoWsRegularForecastByMonth_ + KMPCX._forecastWeightMonths — the internal
 * resolveForecastWeight/buildRegularForecastByMonth are NOT globally callable). LIVE-VERIFY.
 */
/**
 * F1-7N-FC-1B-E3-R3-R1 §1/§3 — THE READ CONTEXT FOR THE FORECAST TABLE.
 *
 * KMFCN is allowed to read an absent month as zero ONLY when the system demonstrably looked and found nothing.
 * `gapReadObjects_` cannot supply that: it returns [] for a sheet that is MISSING and for one that is merely
 * EMPTY, and those two mean opposite things. A missing table read as "every month is zero" would turn a
 * deployment fault into a silent plan for nothing, which is the exact failure the zero-default must not create.
 * So the tab and its header row are inspected directly (read-only) and the result is passed as context.
 */
function weeklyAiPlanForecastReadContext_(ss) {
  try {
    var sh = ss.getSheetByName('fc_regular_forecast');
    if (!sh) return { readSucceeded: true, tableMissing: true, schemaValid: false, headers: [] };
    if (sh.getLastColumn() < 1) return { readSucceeded: true, tableMissing: false, schemaValid: false, headers: [] };
    var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(function (h) { return weeklyAiPlanStr_(h).toLowerCase(); });
    return { readSucceeded: true, tableMissing: false, schemaValid: true, headers: hdr };
  } catch (e) {
    // A THROW IS NOT AN EMPTY TABLE. The outcome is unknown, and unknown never becomes zero.
    return { readSucceeded: false, readOutcomeUnknown: true, transportFailed: true, headers: [] };
  }
}

function weeklyAiPlanBuildKmafReceivers_(ss, scope, sites, upcBySku, errors) {
  var calcMonth = weeklyAiPlanStr_(scope.planningCycle).slice(5);
  var months = (typeof KMPCX !== 'undefined' && KMPCX && typeof KMPCX._forecastWeightMonths === 'function') ? KMPCX._forecastWeightMonths(calcMonth) : null;
  if (!months || months.length < 2) { errors.push(weeklyAiPlanErr_('FORECAST_MONTHS_UNRESOLVED', 'KMPCX._forecastWeightMonths unavailable')); return { fatal: true }; }
  var fcRows = (typeof gapReadObjects_ === 'function') ? gapReadObjects_(ss, 'fc_regular_forecast') : [];
  var warehouses = (typeof gapReadObjects_ === 'function') ? gapReadObjects_(ss, 'warehouses') : [];

  var receivers = [], horizonRows = [], sourceDataAsOf = null;
  // F1-7N-FC-1B-E3-R3-R1 §1/§3 — ONE READING OF AN ABSENT FORECAST MONTH, AND IT IS ZERO.
  //
  // WHAT THIS REPLACES, AND WHY IT WAS WRONG. The §7 basis used to require all four months to be PRESENT and
  // dropped the whole site otherwise (`FORECAST_SHARE_INCOMPLETE`). At a year boundary that is every site: the
  // window for RECO-2026-09 is 2026-10..2027-01 and nobody had created the 2027 base rows, so all 495 active
  // scopes were dropped, the receiver universe was empty, and the AI Plan answered HARVEST_NOT_READY.
  //
  // The same absence was ALREADY being read the opposite way by the same table's other consumer: the
  // recommendation workspace skips a month it cannot resolve and carries on, which is how Site Inventory
  // showed a materialized Suggested Qty of 520 for a SKU with no 2027 row. One fact, two readings, and the
  // Shipping side's was the one that stopped the work.
  //
  // KMFCN is now the only authority for that reading, shared with every other consumer, and it keeps the
  // distinction the old code could not make: `recoWsRegularForecastByMonth_` discards a CONFLICTING duplicate
  // exactly as it discards a missing row, so a genuine data conflict was indistinguishable from a year
  // boundary. KMFCN returns 0 for the three absences and REFUSES a conflict, an invalid value, a missing
  // table, a missing header, an incomplete scope and any unknown read outcome.
  var fcCtx = weeklyAiPlanForecastReadContext_(ss);
  var fcNorm = { explicit_zero: 0, default_zero_blank: 0, default_zero_missing_year: 0, actual: 0 };
  for (var i = 0; i < sites.length; i++) {
    var st = sites[i];
    var demandRef = [scope.company, scope.country, st.marketplace, st.sku, st.destinationWarehouseId].join('|');
    var fcScope = { company: scope.company, country: scope.country, marketplace: st.marketplace };
    var win = KMFCN.normalizeWindow({ context: fcCtx, scope: fcScope, sku: st.sku, months: months,
      matchingRows: KMFCN.rowsForScope(fcRows, fcScope, st.sku) });
    if (!win.ok) {
      // STILL A HARD BLOCK, and now it says WHICH of the eight refusals it is instead of one word that covered
      // a year boundary and a corrupt table alike.
      errors.push(weeklyAiPlanErr_('FORECAST_BASIS_UNRESOLVED', 'forecast month cannot be resolved: ' + win.reason,
        { demandRef: demandRef, reason: win.reason, months: (win.issues || []).map(function (x) { return x.month; }) }));
      continue;
    }
    fcNorm.actual += win.counters.actual_count;
    fcNorm.explicit_zero += win.counters.explicit_zero_count;
    fcNorm.default_zero_blank += win.counters.default_zero_blank_count;
    fcNorm.default_zero_missing_year += win.counters.default_zero_missing_year_count;
    var shareSum = win.basis;
    var b0 = win.values[months[0]], b1 = win.values[months[1]];
    receivers.push({
      receiverKey: demandRef, demandRef: demandRef, demandKey: demandRef, demandDriver: 'FORECAST_DRIVEN',
      company: scope.company, country: scope.country, marketplace: st.marketplace, sku: st.sku, masterSku: st.sku, siteSku: st.siteSku,
      fulfillmentModel: st.fulfillmentModel, allocationPriority: st.allocationPriority, unitsPerCarton: (upcBySku || {})[st.sku],
      windowCode: scope.planningCycle, destinationWarehouseId: st.destinationWarehouseId,
      forecastBasis: { forecastShareQty: shareSum, forecastMonth1: { month: months[0], baseForecast: b0 }, forecastMonth2: { month: months[1], baseForecast: b1 }, targetRules: {}, specialEventDemand: 0 }
    });
    // F1-7N-FC-1B-E3-R4 §E.10 — the lineage travels WITH the quantity. A route that can name the snapshot
    // row it came from can be reconciled later; one that cannot is a number with no provenance, which is
    // the state this round exists to end.
    horizonRows.push({ demandRef: demandRef, cumulativeGapByWindow: st.cumulativeGapByWindow,
      requiredByByWindow: st.requiredByByWindow, demandLineage: st.demandLineage || null,
      liveGapByWindow: st.liveGapByWindow || null });
    if (!sourceDataAsOf && st.sourceDataAsOf) sourceDataAsOf = st.sourceDataAsOf;
  }
  // §1 — EVERY DEFAULT-TO-ZERO IS COUNTED AND CARRIED OUT. A zero that nobody can account for is the
  // thing this contract exists to prevent, so the three provenances are reported separately from the actuals.
  return { fatal: false, receivers: receivers, kmafWarehouses: warehouses, horizonRows: horizonRows,
    calculationDate: calcMonth + '-01', sourceDataAsOf: sourceDataAsOf, forecastNormalization: fcNorm };
}
