// ============================================================
// Kitchen Mama Operation System — Apps Script (modularized source mirror)
// 16_shipping_allocation_handlers.gs — Inventory Replenishment second-layer
//   Recommendation / Execution Plan drafts (shipping_allocation_drafts + _lines)
// NOTE: All .gs files in this folder share ONE global scope in the Apps
//       Script project. Copy them into the project TOGETHER. No imports.
// Implements docs/planning/REQUEST_ORDER_AND_PURCHASE_ORDER_SPEC.md §3.6
//   (canonical schema) + INVENTORY_TABLE_MAPPING_SPEC §11.4 + RECOMMENDATION_RUNTIME §C/§D.
//   - upsertShippingAllocationDraft        : create/update ONE draft header (idempotent by id, or by
//                                            planning_cycle+company+country+marketplace+draft_version)
//   - upsertShippingAllocationDraftLines   : UPSERT lines by allocation_draft_line_id. QUANTITY
//                                            PROTECTION (§D): recommended_* snapshot fields are written
//                                            only when provided; an Execution-Plan save that omits them
//                                            PRESERVES the immutable recommendation snapshot. planned_qty
//                                            is user-editable; a refresh/retry never resets it.
//   - submitShippingAllocationDrafts       : mark drafts submitted (submitted_by/at)
// PLANNING SCRATCHPAD: reserves/deducts NOTHING; the persisted Draft is the SSOT for the active cycle.
// Reuses procurement* helpers (procurementEnsureSheet_/procurementAppendByHeader_/procurementFindRow_/
// procurementTimestamp_/procurementNum_) from the shared global scope. Tables auto-create with the
// documented header (missing-header safe; no existing table/field altered).
// DO NOT persist uncovered_qty / coverage_status / window_label / route-display / source-display (§C).
// ============================================================

// SCHEMA AUTHORITY = the EXISTING user-approved live DB (30-col header / 28-col line). Route context is
// header-level; the line is SKU + qty grain. No selected_* / carrier-cost / user_edited columns on the line
// (those were a prior 52-col SOURCE assumption, not the live DB). Do NOT expand the schema without a separate
// user-authorized migration.
// C2-D1R (2026-08-05): reconciled BYTE-FOR-BYTE to the user-approved EXISTING live DB schema (30-col header
// route grain / 28-col line). The prior 23-col header + 52-col line (Model-1) was a SOURCE expectation that did
// NOT match the live DB — it was the root cause of the PRODUCTION_SAFETY:HEADER_ORDER_MISMATCH. Route context
// (From/To/Method/Last-mile) is HEADER-level here (recommended_* on the Draft header); the line owns SKU + qty.
// recommendation_group_no exists on the header but Phase-1 does NOT use it for multi-active-draft / multi-vessel
// (K3 excludes it). Owner: docs/planning/ALLOCATION_DRAFT_PHASE1_CONTRACT_FREEZE.md.
var SHIPPING_ALLOCATION_DRAFTS_HEADERS_ = [
  'allocation_draft_id', 'planning_cycle', 'source_page', 'company', 'country', 'marketplace', 'status',
  // header-level route context (system recommendation snapshot for this Draft's single route)
  'recommended_source_warehouse_id', 'recommended_destination_warehouse_id',
  'recommended_source_warehouse_code_snapshot', 'recommended_destination_warehouse_code_snapshot',
  'recommendation_group_no', 'recommended_shipping_method', 'recommended_last_mile_delivery',
  // generation / calculation provenance
  'generation_type', 'calculation_run_id', 'formula_version', 'calculated_at', 'source_data_as_of', 'draft_version',
  // audit / lifecycle
  'created_by', 'created_at', 'updated_by', 'updated_at',
  'submitted_by', 'submitted_at', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'note'
];

// ============================================================================================================
// F1-7N-FB-4C-ADDENDUM-MIGRATION §D — THE LIFECYCLE TAIL, AND WHY IT IS A SEPARATE CONSTANT.
//
// The AI Plan draft lifecycle needs four audit columns. The obvious move - append them to
// SHIPPING_ALLOCATION_DRAFTS_HEADERS_ above - was AUDITED AND REJECTED, because that constant is what every
// caller passes to procurementEnsureSheet_ -> prodRequireSheet_, and prodRequireSheet_ fails closed on a
// MISSING expected header (classifySchemaMismatch: missingHeaders.length -> HEADER_MISSING -> invalid). Adding
// them there would mean that the moment 16_ is synced, and until the migration runs, EVERY shipping-allocation
// read and write - manual Execution Plan saves included - throws PRODUCTION_SAFETY:HEADER_MISSING. There is no
// deployment order that avoids that window, because the reverse order breaks the exact-schema write gate.
//
// So the two lists are deliberately different things:
//   SHIPPING_ALLOCATION_DRAFTS_HEADERS_           the REQUIRED contract - 30 columns, frozen. Extra columns are
//                                                 ALLOWed by this table's additive contract, so a migrated sheet
//                                                 satisfies it unchanged.
//   ..._DRAFTS_HEADERS_CANONICAL_                 the CANONICAL post-migration order - the required 30 followed
//                                                 by the lifecycle tail in ONE documented order.
// The write gate (sadExactSchemaReason_) validates against the CANONICAL list with the tail marked optional, so
// a pre-migration sheet (30) and a migrated sheet (34) are BOTH exact - and anything else, including a tail in
// the wrong order or any unknown extra column, still fails. The result is that code sync and schema migration
// are ORDER-INDEPENDENT: neither one alone can break a write, and the lifecycle simply stays gated (see
// aiplActivationGate_) until the columns actually exist.
//
// CANONICAL ORDER IS APPEND-ONLY AND FIXED: generation_run_id, expired_at, expired_by_run_id, expiration_reason,
// at indexes 30, 31, 32, 33. No live column is ever reordered or rewritten.
var SAD_LIFECYCLE_TAIL_COLUMNS_ = ['generation_run_id', 'expired_at', 'expired_by_run_id', 'expiration_reason'];
var SHIPPING_ALLOCATION_DRAFTS_HEADERS_CANONICAL_ =
  SHIPPING_ALLOCATION_DRAFTS_HEADERS_.concat(SAD_LIFECYCLE_TAIL_COLUMNS_);

// ============================================================================================================
// F1-7N-FB-4F-B3 - CODE-FIRST SCHEMA COMPATIBILITY. The runtime learns the two new columns BEFORE they exist.
//
// WHY THIS ORDER, AND WHY THE OPPOSITE ORDER BREAKS THE PAGE. B2 measured it against this file's own gate: the
// header write gate is POSITIONAL AND EXACT, so a column the authority does not know about is not an inert
// blank - it is a positional mismatch, and every allocation read and write fails closed the moment it appears.
//     header live 30 + destination_marketplace -> COL30_IS_destination_marketplace_EXPECTED_generation_run_id
//     header live 34 + destination_marketplace -> COL_COUNT_35_EXPECTED_30_TO_34
//     line   live 30 + expected_arrival        -> COL_COUNT_31_EXPECTED_30
// So the authority must learn them FIRST, as OPTIONAL tail entries, which makes a pre-append sheet and a
// post-append sheet BOTH exact and leaves the two operations order-independent in either direction. That is the
// same conclusion, for the same reason, that the lifecycle-tail note above reached for its four columns.
//
// AND THE EXISTING CANONICAL CONSTANT IS DELIBERATELY NOT WIDENED. TEMP_migrate_shipping_allocation_ai_lifecycle
// reads SHIPPING_ALLOCATION_DRAFTS_HEADERS_CANONICAL_ as ITS canonical target and appends everything past the
// live length. Widening it there would make the LIFECYCLE migration append destination_marketplace too - one
// tool quietly doing another's job, at an index the lifecycle order does not own. The gate gets a new, wider
// authority; the migration keeps targeting exactly the 34 it was written for.
//
// THE ROUTE-IDENTITY TAIL, at index 34 and NEVER at 30. The lifecycle tail owns 30..33 by a frozen decision, and
// TEMP_migrate_shipping_allocation_ai_lifecycle refuses any live header carrying an unknown extra column. Placing
// destination_marketplace at 30 would therefore not merely be untidy - it would refuse that queued migration
// permanently. The two appends are ordered, not interchangeable: lifecycle tail first, route identity second.
var SAD_ROUTE_IDENTITY_TAIL_COLUMNS_ = ['destination_marketplace'];

// F1-7N-FB-4G-A2-R3 §F — THE CREATE IDEMPOTENCY TAIL, APPENDED AT 35 AND NOWHERE ELSE.
//
// A2-R3 §B.2 settles the product rule: an explicit + Add Route is ALWAYS a new ticket, even when its
// From / To / Method are identical to an existing one. So the K4 route key is grouping information, not the
// entity key, and a K4 collision may no longer refuse a create. Removing that refusal removes the only thing
// that was stopping a retried click from producing a second ticket — measured: with the refusal gone, the
// same create key sent twice produced SADH-K2-CBB7E7F6 and then SAD-UUID100000, two headers.
//
// Nothing already stored can distinguish "one click, retried after a lost response" from "a second click":
// the client's create key was accepted on the wire and then had nowhere to live. This column is that place.
// It is APPENDED (never inserted), existing rows stay blank, and it is never back-filled — a blank key means
// "created before this contract existed" and must never be read as a replay of anything.
var SAD_CREATE_IDEMPOTENCY_TAIL_COLUMNS_ = ['create_idempotency_key'];

// The complete optional tail the write gate accepts, in canonical order: lifecycle 30..33, route identity 34,
// create idempotency 35. The three appends are ORDERED, not interchangeable.
var SAD_HEADER_OPTIONAL_TAIL_COLUMNS_ = SAD_LIFECYCLE_TAIL_COLUMNS_
  .concat(SAD_ROUTE_IDENTITY_TAIL_COLUMNS_)
  .concat(SAD_CREATE_IDEMPOTENCY_TAIL_COLUMNS_);

// The FULL header authority the write gate validates against: 30 required + 6 optional = 36. Accepted live
// lengths are 30..36 and every present column must sit at its exact canonical index, so destination_marketplace
// at 30, a lifecycle column out of order, an unknown name, a duplicate, a case variant, a blank intervening
// header and a 37th column are each refused by the SAME positional rule rather than by six separate checks.
var SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_ =
  SHIPPING_ALLOCATION_DRAFTS_HEADERS_.concat(SAD_HEADER_OPTIONAL_TAIL_COLUMNS_);

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R1 §5 — ONE SCHEMA AUTHORITY FOR `shipping_allocation_drafts`.
//
// THE DEFECT THIS REPLACES. Two pieces of code were deciding whether this table's header was acceptable, and
// they disagreed. The WRITE gate validated against the FULL authority with the optional tail, so a live sheet
// at 34, 35 or 36 columns was exact and writable. The AI Plan lifecycle asked a different question through
// aiplSchemaVersionOf_, which required the header to equal SHIPPING_ALLOCATION_DRAFTS_HEADERS_CANONICAL_
// BYTE-FOR-BYTE — and that constant is deliberately frozen at 34, because the lifecycle MIGRATION appends
// against it. So the moment either later append migration ran, a perfectly legal production sheet reported NO
// schema version at all, and every AI Plan generation refused with MIGRATION_VERSION_MISMATCH and zero writes.
//
// The refusal even told the operator to sync the Apps Script project, which could not have helped: the code
// was current and the table was correct. The stale thing was the version resolver, which had never been
// widened when the two appends shipped.
//
// SO THE SHAPES ARE ENUMERATED, NOT COUNTED. Each entry below is a schema GENERATION this repository has
// actually migrated to, named, in append order. A live header is compared POSITIONALLY against exactly one of
// them. Counting columns would accept an unknown 35th name, a swapped tail and a duplicate alike, which is the
// failure mode a "length is between 30 and 36" test would reintroduce — so length only ever SELECTS the
// candidate generation, and never approves anything by itself.
//
// A HALF-APPLIED MIGRATION IS NOT A GENERATION. 31, 32 and 33 columns mean a tail append stopped partway, and
// they are refused: an interrupted migration is a state to finish, not one to write through.
//
// Both consumers read THIS, and each applies its own POLICY to the one fact: the writer accepts any recognized
// generation (a pre-migration 30-column sheet included), while the lifecycle additionally requires the four
// lifecycle columns to be present. One authority, two policies — never two opinions.
var SAD_SCHEMA_GENERATIONS_ = [
  { version: 'SAD-HEADERS-30-BASE', appended: [], lifecycle_complete: false,
    migration: '(pre-migration base contract)' },
  { version: 'FB4C-AI-LIFECYCLE-1', appended: SAD_LIFECYCLE_TAIL_COLUMNS_, lifecycle_complete: true,
    migration: 'TEMP_migrate_shipping_allocation_ai_lifecycle (F1-7N-FB-4C) — appends 30..33' },
  { version: 'FB4F-B4-ROUTE-IDENTITY-1',
    appended: SAD_LIFECYCLE_TAIL_COLUMNS_.concat(SAD_ROUTE_IDENTITY_TAIL_COLUMNS_), lifecycle_complete: true,
    migration: 'F1-7N-FB-4F-B4 two-column append — appends destination_marketplace at 34' },
  { version: 'FB4G-A2R3-CREATE-IDEMPOTENCY-1',
    appended: SAD_HEADER_OPTIONAL_TAIL_COLUMNS_, lifecycle_complete: true,
    migration: 'TEMP_migrate_create_idempotency_key_a2_r3 (F1-7N-FB-4G-A2-R3) — appends create_idempotency_key at 35' }
];

function sadSchemaGenerationColumns_(g) { return SHIPPING_ALLOCATION_DRAFTS_HEADERS_.concat(g.appended || []); }
function sadSupportedSchemaVersions_() {
  return SAD_SCHEMA_GENERATIONS_.map(function (g) {
    return { version: g.version, column_count: sadSchemaGenerationColumns_(g).length,
      lifecycle_complete: g.lifecycle_complete === true, migration: g.migration };
  });
}

/**
 * §5/§6 — resolve a LIVE header row to a named schema generation. PURE over an array of strings, so the
 * writer, the lifecycle gate, the Census and every test reach the same verdict from the same input.
 *
 * Returns { ok, version, column_count, lifecycle_complete, reason, first_mismatch, missing_headers,
 *           unexpected_headers, reordered_headers, duplicate_headers, supported_versions }.
 */
function sadResolveHeaderSchema_(liveHeaders) {
  var a = (liveHeaders || []).map(function (h) { return String(h == null ? '' : h).trim(); });
  while (a.length && a[a.length - 1] === '') a.pop();
  var out = { ok: false, version: null, column_count: a.length, lifecycle_complete: false, reason: null,
    first_mismatch: null, missing_headers: [], unexpected_headers: [], reordered_headers: [],
    duplicate_headers: [], supported_versions: sadSupportedSchemaVersions_() };

  // A duplicate is checked FIRST and on its own. Positional comparison cannot see it (the second copy simply
  // mismatches at its index), and "column 34 is wrong" is a badly misleading way to report "status appears twice".
  var seen = {};
  for (var i = 0; i < a.length; i++) {
    if (a[i] === '') continue;
    if (seen[a[i]]) { if (out.duplicate_headers.indexOf(a[i]) === -1) out.duplicate_headers.push(a[i]); }
    seen[a[i]] = 1;
  }
  if (out.duplicate_headers.length) { out.reason = 'DUPLICATE_HEADER:' + out.duplicate_headers.join(','); return out; }

  var cand = null;
  for (var g = 0; g < SAD_SCHEMA_GENERATIONS_.length; g++) {
    if (sadSchemaGenerationColumns_(SAD_SCHEMA_GENERATIONS_[g]).length === a.length) { cand = SAD_SCHEMA_GENERATIONS_[g]; break; }
  }
  if (!cand) {
    out.reason = 'COL_COUNT_' + a.length + '_UNSUPPORTED_EXPECTED_'
      + out.supported_versions.map(function (v) { return v.column_count; }).join('_OR_');
    // Name what is missing / extra relative to the WIDEST known shape, so the report says which append is
    // half-applied rather than only that the count is odd.
    var widest = SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_;
    widest.forEach(function (c) { if (a.indexOf(c) === -1) out.missing_headers.push(c); });
    a.forEach(function (c) { if (c !== '' && widest.indexOf(c) === -1) out.unexpected_headers.push(c); });
    return out;
  }

  var want = sadSchemaGenerationColumns_(cand);
  for (var j = 0; j < want.length; j++) {
    if (a[j] !== want[j]) {
      out.first_mismatch = { index: j, actual: a[j] || '(blank)', expected: want[j] };
      out.reason = 'COL' + j + '_IS_' + (a[j] || '(blank)') + '_EXPECTED_' + want[j];
      want.forEach(function (c) { if (a.indexOf(c) === -1) out.missing_headers.push(c); });
      a.forEach(function (c, idx) {
        if (c === '') return;
        var at = want.indexOf(c);
        if (at === -1) out.unexpected_headers.push(c);
        else if (at !== idx) out.reordered_headers.push({ column: c, actual_index: idx, expected_index: at });
      });
      return out;
    }
  }
  out.ok = true;
  out.version = cand.version;
  out.lifecycle_complete = cand.lifecycle_complete === true;
  return out;
}

// The WRITER's policy over that fact: any recognized generation may be written, the pre-migration base
// included. Returns '' when acceptable, else the same COLn_IS_ / COL_COUNT_ reason shape the gate always emitted.
function sadDraftsSchemaReason_(sh) {
  var r = sadResolveHeaderSchema_(sadLiveHeaderNames_(sh));
  return r.ok ? '' : (r.reason || 'SCHEMA_UNRESOLVED');
}

var SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_ = [
  // identity
  'allocation_draft_line_id', 'allocation_draft_id', 'sku', 'site_sku',
  // window
  'window_code', 'window_start_date', 'window_end_date', 'required_by_date',
  // recommendation input snapshots
  'regular_demand_snapshot', 'special_event_demand_snapshot', 'destination_stock_snapshot',
  'qualified_incoming_snapshot', 'approved_supply_snapshot', 'calculated_gap_qty',
  // source-availability snapshots + allocation sequence (immutable)
  'source_initial_available_qty_snapshot', 'source_available_before_allocation_snapshot', 'allocation_sequence',
  // recommendation reason/flags + immutable recommended qty snapshot
  'recommendation_reason', 'recommendation_flags', 'recommended_qty',
  // F1-7N-FA-3C-R6F1 — per-source axis, at the CANONICAL LIVE position (immediately after recommended_qty, BEFORE the
  // user Execution Plan). This is the exact byte-for-byte live production order (djb2 '|' fingerprint = e4880646, 30
  // cols). Under the K2 shipment-group model the source warehouse is a HEADER grouping dimension; on the line these
  // are the denormalized per-line source snapshot carried for the natural key. The prior R3C2 per-source-qty column
  // `source_allocated_qty_snapshot` is NOT present in the live schema — it was an accidental source-only 31st field
  // (never live-verified) and is REMOVED here so the runtime authority equals the live 30-col schema exactly.
  'source_warehouse_id', 'source_warehouse_code_snapshot',
  // user Execution Plan (qty grain — route context is on the Draft header)
  'planned_qty', 'units_per_carton', 'route_no',
  // status / audit
  'line_status', 'override_reason', 'note', 'created_at', 'updated_at'
];

// F1-7N-FB-4F-B3 - THE LINE ETA TAIL. `expected_arrival` is a LINE field in the canonical model
// (DATABASE_RELATIONSHIP_MAP §360) and is spelled exactly as that model spells it - not `expected_arrival_date`,
// and not on the header. Being line-owned is not a filing preference: route identity is a HEADER key, so a line
// attribute CANNOT reach it, and "same route, changed ETA updates the same route" is guaranteed by the schema
// shape rather than by a rule someone has to remember.
//
// The line gate had NO optional-tail mechanism at all before this round - it demanded exactly 30 - which is why
// B2 measured COL_COUNT_31_EXPECTED_30 for the append. It gets one now, on the same append-only terms as the
// header: required stays 30 so a pre-append sheet is still exact, and 31 is exact once the column exists.
var SAD_LINE_ETA_TAIL_COLUMNS_ = ['expected_arrival'];
var SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_ =
  SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_.concat(SAD_LINE_ETA_TAIL_COLUMNS_);

// F1-7N-FB-4C §D — `expired` joins the enum. It is NOT a synonym for `cancelled`: cancelled is a human
// decision to abandon a plan, expired is the system recording that a NEWER SUCCESSFUL AI Plan run replaced this
// one. They have different causes, different audit columns and different meanings in a report, so conflating
// them would destroy the distinction the lifecycle exists to record.
// An expired row is READ-ONLY: it is not editable, not submittable, and not part of any active set below.
var SAD_STATUSES_ = { draft: 1, site_confirmed: 1, submitted: 1, cancelled: 1, expired: 1 };
// ADDENDUM §D/§H — the LINE status authority, written down. `line_status` already exists as a column, so no
// line column is added by the migration; what was missing was an explicit enum. Before this, `expired` was
// accepted on a line only by OMISSION - nothing validated line_status at all - which is not the same thing as
// being accepted, and §H requires `expired` to be positively accepted by BOTH validators.
var SAD_LINE_STATUSES_ = {
  draft: 1, planned: 1, site_confirmed: 1, submitted: 1, cancelled: 1, expired: 1,
  superseded: 1, superseded_user_review: 1
};
function sadHeaderStatusValid_(v) { return !!SAD_STATUSES_[String(v == null ? '' : v).trim().toLowerCase()]; }
function sadLineStatusValid_(v) {
  var t = String(v == null ? '' : v).trim().toLowerCase();
  return t === '' || !!SAD_LINE_STATUSES_[t];       // blank stays legal: most writers never set a line status
}
// The statuses no writer may mutate. `expired` is terminal for the same reason `submitted` is: it is history.
var SAD_TERMINAL_STATUSES_ = { submitted: 1, cancelled: 1, expired: 1 };
var SAD_TERMINAL_LINE_STATUSES_ = { submitted: 1, cancelled: 1, expired: 1, superseded: 1, superseded_user_review: 1 };
// F1-7N-FC-1B-E3-R4-A2-R1-R2 §5 — `system_generated` JOINS THE VOCABULARY, because it was already the
// value the rest of the system used and the only list that did not know it was this one. 16_ tests for the
// literal in two places, 69_'s AIPL_AI_GENERATION_TYPES_ contains it, and sadUpsertDraftHeaderCore_ silently
// coerced it to `user_created` — which is precisely how an AI row came to carry a MANUAL provenance marker.
var SAD_GENERATION_TYPES_ = { scheduled: 1, manual_refresh: 1, user_created: 1, system_generated: 1 };

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R2 §2 — THE THIRD ROUTE INTENT, AND WHY TWO WERE NOT ENOUGH.
//
// A2-R3 made every route write declare what it MEANS rather than letting the writer infer it from whether a
// natural key happened to match. That was right, and it had exactly two answers: an explicit user Add Route
// (always a new ticket) and an explicit edit of a row named by id. The AI Plan is neither. It performs a
// CREATE-OR-RECONCILE against a DETERMINISTIC K2 group identity: the first run creates SADH-K2-<hash>, and a
// replay of the same cycle must resolve to that same row and update it.
//
// So the AI Plan's call site had no answer it could truthfully give, and being unable to give one it gave
// none — which is why every generation refused with ROUTE_INTENT_REQUIRED and wrote nothing. Measured, the
// two available intents are not merely inconvenient, they are WRONG:
//
//   CREATE_NEW_ROUTE      writes, but mints a K4 create identity (SADH-K4-...), bypassing the deterministic
//                         K2 identity that makes a replay idempotent. The row is then indistinguishable from
//                         an operator's ticket, and the next generation reads its OWN output back as a
//                         binding manual decision (ALL_SUPPRESSED_BY_MANUAL).
//   UPDATE_EXISTING_ROUTE refuses: it requires the allocation_draft_id of a row the first run has not created.
//
// This intent is therefore a THIRD canonical operation, not an alias for either and not a relaxation of the
// gate. It is SERVER-OWNED: 01_router.gs refuses it outright from any external request, and the evidence gate
// below re-checks it at the writer, so an internal caller that has not actually done the work cannot use it.
var SAD_AI_K2_INTENT_ = 'UPSERT_AI_GENERATED_K2_ROUTE';
var SAD_ROUTE_INTENTS_ = {
  CREATE_NEW_ROUTE: { owner: 'user', identity: 'mints a new manual (K4) identity; the resolver is never consulted' },
  UPDATE_EXISTING_ROUTE: { owner: 'user', identity: 'updates the row named by allocation_draft_id, in place' },
  UPSERT_AI_GENERATED_K2_ROUTE: { owner: 'server', identity: 'resolves the deterministic K2 group identity; creates or reconciles it' }
};
// The two a request may legitimately declare. The third is not in this set and never becomes reachable by
// adding a field to a payload.
var SAD_CLIENT_GRANTABLE_INTENTS_ = { CREATE_NEW_ROUTE: 1, UPDATE_EXISTING_ROUTE: 1 };

/**
 * §3 — THE EVIDENCE THAT EARNS THE AI INTENT. A declaration is not authority.
 *
 * `enforce_k2_grouping: true` alone must NOT be enough: it is a routing hint that any caller can set, and
 * treating it as authorization would make the third intent a public one. What is checked here is the set of
 * things only a real weekly-AI-Plan generation possesses at this point: a deterministic execution key, an
 * AI generation run id, the gap-run lineage that admitted the demand, an AI provenance marker, a COMPLETE
 * route, resolvable K2 identity inputs, and a scope inside the server-owned activation allowlist.
 *
 * Anything missing or contradictory is a typed refusal with ZERO writes. Fail closed, and say which fact.
 */
function sadAiK2IntentEvidence_(body, header, lines, liveHeaderNames) {
  body = body || {}; header = header || {};
  var missing = [], evidence = {};
  function S(v) { return String(v == null ? '' : v).trim(); }

  // 1. K2 grouping must actually be in force, or "the deterministic K2 identity" names nothing.
  evidence.enforce_k2_grouping = (body.enforce_k2_grouping === true);
  if (!evidence.enforce_k2_grouping) missing.push('enforce_k2_grouping must be true for a K2 upsert');

  // 2. The execution key: the caller's own deterministic name for THIS generation attempt.
  var execKey = S(body.execution_key || body.executionKey || header.execution_key);
  evidence.execution_key = execKey;
  if (!execKey) missing.push('execution_key (the deterministic name of this generation attempt)');
  else if (execKey.length > 200) missing.push('execution_key is not a deterministic key (over 200 chars)');

  // 3. AI provenance. A generation run id is what lets a later run tell its own rows from the ones it replaces.
  var runId = S(header.generation_run_id);
  evidence.generation_run_id = runId;
  if (!runId) missing.push('header.generation_run_id (this run\'s immutable id)');
  else if (!/^AIRUN-/.test(runId)) missing.push('header.generation_run_id is not an AI generation run id (expected AIRUN-...)');

  var genType = S(header.generation_type).toLowerCase();
  evidence.generation_type = genType;
  if (genType !== 'system_generated') {
    missing.push('header.generation_type must be system_generated (found "' + (genType || '(blank)') + '") — '
      + 'an AI row stored with a manual marker is read back as a binding operator decision');
  }

  // 4. The demand lineage that admitted this quantity. Without it the row is a number with no provenance.
  var calcRun = S(header.calculation_run_id);
  evidence.calculation_run_id = calcRun;
  if (!calcRun) missing.push('header.calculation_run_id (the GAP-INV run this plan was computed from)');

  // 5. A COMPLETE route. A partial route persisted under an AI identity is the shape §7 forbids.
  var src = S(header.recommended_source_warehouse_id);
  var dest = S(header.recommended_destination_warehouse_id) || S(header.destination_marketplace);
  var method = S(header.recommended_shipping_method);
  evidence.route = { from: src, to: dest, method: method };
  if (!src) missing.push('header.recommended_source_warehouse_id (From)');
  if (!dest) missing.push('a destination (recommended_destination_warehouse_id or destination_marketplace)');
  if (!method) missing.push('header.recommended_shipping_method (Method)');

  // 6. The K2 identity inputs themselves must resolve, or there is nothing deterministic to upsert INTO.
  var gkey = (typeof sadK2GroupKey_ === 'function') ? S(sadK2GroupKey_(header)) : '';
  evidence.k2_group_key = gkey;
  if (!gkey) missing.push('the K2 group identity does not resolve from this header');

  // 7. THE SERVER-OWNED ALLOWLIST, re-checked at the writer. 61_ gates it too; this is the last point before a
  // row exists, and a guard that only runs upstream is a guard an internal caller can skip.
  var company = S(header.company), country = S(header.country), mkt = S(header.marketplace);
  evidence.scope = { company: company, country: country, marketplace: mkt };
  if (typeof inventoryAiPlanScopeEnabled_ !== 'function') {
    missing.push('the activation allowlist is not present in this deployment');
  } else {
    var skus = {}, outside = [];
    (lines || []).forEach(function (l) { var k = S(l && l.sku); if (k) skus[k] = 1; });
    var skuList = Object.keys(skus);
    if (!skuList.length) missing.push('no line carries a sku, so the scope cannot be checked against the allowlist');
    skuList.forEach(function (k) {
      if (!inventoryAiPlanScopeEnabled_(company, country, mkt, k)) outside.push(k);
    });
    evidence.skus = skuList;
    evidence.outside_allowlist = outside;
    if (outside.length) {
      missing.push('scope is outside the controlled activation allowlist for sku(s): ' + outside.join(', '));
    }
  }

  // 8. Whether the execution key can actually be STORED. Not a refusal: the K2 identity is the replay
  // authority, and a 34/35-column deployment that cannot hold the key is still safe to upsert into. It is
  // REPORTED so a reader never has to infer why the column came back blank.
  evidence.execution_key_persistable = (typeof sadCreateIdempotencyReady_ === 'function')
    ? sadCreateIdempotencyReady_(liveHeaderNames || []) === true : false;

  return { ok: missing.length === 0, missing: missing, evidence: evidence };
}


// The recommendation-snapshot fields — written only when the incoming line supplies them, so an
// Execution-Plan save (which omits them) never clobbers the immutable recommendation (§D). Canonical
// names (2026-07-27 sync).
// C2-D1R: reconciled to the 28-col LINE snapshot fields ONLY. The recommended route fields
// (recommended_source/destination_warehouse_id/code, recommended_shipping_method/last_mile) are HEADER-level
// now, so they are NOT line snapshot-protected fields.
var SAD_RECOMMENDATION_FIELDS_ = [
  'recommended_qty',
  'source_initial_available_qty_snapshot', 'source_available_before_allocation_snapshot', 'allocation_sequence',
  'recommendation_reason', 'recommendation_flags',
  'regular_demand_snapshot', 'special_event_demand_snapshot', 'destination_stock_snapshot',
  'qualified_incoming_snapshot', 'approved_supply_snapshot', 'calculated_gap_qty',
  'window_code', 'window_start_date', 'window_end_date', 'required_by_date'
];

// Read-only legacy aliases accepted on the incoming shipping-draft line payload → canonical column.
// Keeps the existing (not-yet-migrated, still gated) Inventory Replenishment caller working without
// editing it; new writes always use the canonical key.
// C2-D1R: the only LINE-level legacy alias that still targets an existing 28-col line column. Route aliases
// (ship_from/destination/source_warehouse_id) belonged to the removed selected_* line grain — route is now a
// HEADER field and the frontend header payload uses the canonical recommended_* names directly.
var SAD_LINE_LEGACY_ALIASES_ = {
  source_available_qty_snapshot: 'source_initial_available_qty_snapshot'
};

// Copy legacy alias keys to their canonical name when the canonical key is absent (never overwrites an
// explicitly-provided canonical value).
function sadApplyLineAliases_(l) {
  for (var legacy in SAD_LINE_LEGACY_ALIASES_) {
    if (!SAD_LINE_LEGACY_ALIASES_.hasOwnProperty(legacy)) continue;
    var canon = SAD_LINE_LEGACY_ALIASES_[legacy];
    if ((l[canon] == null || l[canon] === '') && l[legacy] != null && l[legacy] !== '') l[canon] = l[legacy];
  }
  return l;
}

// ---- upsertShippingAllocationDraft --------------------------------
/**
 * Create/update ONE allocation-draft header. Body:
 *   { allocation_draft_id?, planning_cycle?, source_page?, company?, country?, marketplace?, status?,
 *     generation_type?, calculation_run_id?, calculated_at?, source_data_as_of?, draft_version?,
 *     created_by?, note? }
 * status defaults to draft; generation_type defaults to user_created. If no id is given, an existing
 * header matching planning_cycle+company+country+marketplace+draft_version is reused (idempotent);
 * a repeated calculation_run_id is treated as the same draft. Returns { allocation_draft_id }.
 */
// Round 1H enforcement: PUBLIC header route now acquires the ScriptLock + terminal-guards an existing header
// before delegating to the (private) single-keyed-row upsert core. Shipping stays DEPLOYMENT-GATED (scaffold).
function handleUpsertShippingAllocationDraft_(body) {
  var lock = LockService.getScriptLock();
  try { if (!lock.tryLock(30000)) return jsonResponse_({ success: false, error: 'Could not acquire lock; please retry.', stage: 'lock' }); }
  catch (e) { return jsonResponse_({ success: false, error: 'Lock error: ' + (e && e.message ? e.message : e), stage: 'lock' }); }
  try {
    var ss0 = SpreadsheetApp.getActiveSpreadsheet();
    var id0 = String((body && body.allocation_draft_id) || '').trim();
    if (id0) {
      var sh0 = procurementEnsureSheet_(ss0, 'shipping_allocation_drafts', SHIPPING_ALLOCATION_DRAFTS_HEADERS_);
      var f0 = procurementFindRow_(sh0, 'allocation_draft_id', id0);
      if (f0) { var cS0 = f0.col('status'); var st0 = cS0 !== -1 ? String(sh0.getRange(f0.row, cS0 + 1).getValue()).trim().toLowerCase() : ''; if (SAD_TERMINAL_STATUSES_[st0]) return jsonResponse_({ success: false, error: 'IMMUTABLE_TERMINAL_STATUS:' + st0, stage: 'terminal' }); }
    }
    return sadUpsertDraftHeaderCore_(body);
  } finally { try { lock.releaseLock(); } catch (e2) { /* best-effort release */ } }
}

// Private single-keyed-row shipping header upsert core (reached ONLY under lock via the public handler above).
function sadUpsertDraftHeaderCore_(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = procurementEnsureSheet_(ss, 'shipping_allocation_drafts', SHIPPING_ALLOCATION_DRAFTS_HEADERS_);
  var now = procurementTimestamp_();
  var actor = String((body && body.created_by) || 'inventory-replenishment').trim();
  var status = String((body && body.status) || 'draft').trim();
  if (!SAD_STATUSES_[status]) status = 'draft';
  var genType = String((body && body.generation_type) || 'user_created').trim();
  if (!SAD_GENERATION_TYPES_[genType]) genType = 'user_created';
  var draftVersion = String((body && body.draft_version) || '1').trim();

  // C2-D1R header-route completeness gate (§8): when the header carries route intent, From + To + Method must
  // all be present (unless this is a soft-cancel). A partial route rejects with PLAN_HEADER_INCOMPLETE and
  // writes nothing. Route context is HEADER-level in the approved 30-col schema.
  // F1-7N-FB-4G-A0-R2 — destination_marketplace is one of the two canonical destination axes, so a payload
  // carrying it IS route intent. Omitting it here meant a marketplace-only body skipped the gate below.
  var hasRouteIntent = !!(body && (String(body.recommended_source_warehouse_id || '').trim() ||
    String(body.recommended_shipping_method || '').trim() || String(body.recommended_destination_warehouse_id || '').trim() ||
    String(body.destination_marketplace || '').trim()));
  if (hasRouteIntent && status !== 'cancelled' && !sadHeaderRouteIsComplete_(body)) {
    return jsonResponse_({ success: false, error: 'PLAN_HEADER_INCOMPLETE — a Draft route context requires From + To + Method (zero rows written)' });
  }

  // F1-7N-FB-4G-A0-R1 — A SUPPLIED MARKETPLACE WITH NO COLUMN IS A REFUSAL, NOT A SILENT DROP.
  //
  // setCol is a no-op when the column is absent, and procurementAppendByHeader_ ignores an unknown name, so on a
  // pre-migration sheet this writer would accept an Amazon route, report success, and store a row with no
  // destination — which Submit would later refuse with ROUTE_INCOMPLETE, long after the operator was told the
  // save worked. The ATOMIC writer already refuses this exact case (sadSchemaRefusal_); the two writers must
  // not disagree about whether a route is persistable.
  if (body && String(body.destination_marketplace == null ? '' : body.destination_marketplace).trim() !== '') {
    var _hdrNames = sadLiveHeaderNames_(sh);
    if (!sadHasColumn_(_hdrNames, 'destination_marketplace')) {
      return { success: false, error: 'ROUTE_IDENTITY_NOT_PERSISTABLE', code: 'ALLOCATION_DRAFT_SCHEMA_COLUMN_ABSENT',
        stage: 'schema', zero_write: true,
        data: { column: 'destination_marketplace', table: 'shipping_allocation_drafts' } };
    }
  }
  var allowReconcile = (body && body.allow_legacy_reconcile === true);
  var id = String((body && body.allocation_draft_id) || '').trim();
  var found = id ? procurementFindRow_(sh, 'allocation_draft_id', id) : null;

  // ============================================================================================================
  // F1-7N-FB-4G-A2-R2 §2/§5 - THE EXPLICIT INTENT CONTRACT.
  //
  // Until now this writer INFERRED the operation from whether a natural key matched an active header: a match
  // REUSED it, no match CREATED one. That made "the operator changed this route's Method" indistinguishable
  // from "this is a different shipment", and it is why one UI route edited across three dimensions became
  // three headers. A route write now DECLARES which operation it is, and an undeclared or self-contradictory
  // one is refused with zero writes.
  //
  // EXEMPT: a soft-cancel of an empty header (status='cancelled') and any payload carrying no route intent at
  // all. Those are not route operations, they are lifecycle ones, and requiring an intent of them would break
  // the empty-header cleanup that System Repair 2 §5.3 depends on.
  var sadIntent = String((body && body.intent) || '').trim();
  if (hasRouteIntent && status !== 'cancelled') {
    if (sadIntent !== 'UPDATE_EXISTING_ROUTE' && sadIntent !== 'CREATE_NEW_ROUTE') {
      return { success: false, error: 'ROUTE_INTENT_REQUIRED', code: 'ROUTE_INTENT_REQUIRED', stage: 'intent',
        zero_write: true, data: { received_intent: sadIntent,
          message: 'a route write must declare intent = UPDATE_EXISTING_ROUTE or CREATE_NEW_ROUTE; it is never inferred from whether a natural key matches (zero rows written)' } };
    }
    if (sadIntent === 'UPDATE_EXISTING_ROUTE' && !id) {
      return { success: false, error: 'ROUTE_INTENT_CONTRADICTORY', code: 'ROUTE_INTENT_CONTRADICTORY', stage: 'intent',
        zero_write: true, data: { intent: sadIntent, message: 'UPDATE_EXISTING_ROUTE requires the allocation_draft_id of the route being updated (zero rows written)' } };
    }
    if (sadIntent === 'CREATE_NEW_ROUTE' && id) {
      return { success: false, error: 'ROUTE_INTENT_CONTRADICTORY', code: 'ROUTE_INTENT_CONTRADICTORY', stage: 'intent',
        zero_write: true, data: { intent: sadIntent, allocation_draft_id: id, message: 'CREATE_NEW_ROUTE must not name an existing allocation_draft_id (zero rows written)' } };
    }
    // §4 - + Add Route is an explicit request for a NEW shipment. It may never drift into adopting a legacy or
    // zero-line header, which is exactly what happened live: the new route's natural key resolved onto an
    // existing route-incomplete header and came back LEGACY_ROUTE_RECONCILIATION_REQUIRED.
    if (sadIntent === 'CREATE_NEW_ROUTE' && allowReconcile) {
      return { success: false, error: 'ROUTE_INTENT_CONTRADICTORY', code: 'ROUTE_INTENT_CONTRADICTORY', stage: 'intent',
        zero_write: true, data: { intent: sadIntent, message: 'CREATE_NEW_ROUTE cannot carry allow_legacy_reconcile: adopting an existing header is a separate, explicitly-confirmed migration (zero rows written)' } };
    }
  }

  // ---- UPDATE_EXISTING_ROUTE: the row is named, so it is updated in place or refused. NEVER created. --------
  if (sadIntent === 'UPDATE_EXISTING_ROUTE' && hasRouteIntent && status !== 'cancelled') {
    if (!found) {
      return { success: false, error: 'ALLOCATION_DRAFT_NOT_FOUND', code: 'ALLOCATION_DRAFT_NOT_FOUND', stage: 'validation',
        zero_write: true, data: { allocation_draft_id: id } };
    }
    var uObj = sadRowToObject_(sh, found.row);
    var uStatus = String(uObj.status == null ? '' : uObj.status).trim().toLowerCase();
    if (SAD_TERMINAL_STATUSES_[uStatus]) {
      return { success: false, error: 'IMMUTABLE_TERMINAL_STATUS:' + uStatus, code: 'IMMUTABLE_TERMINAL_STATUS',
        stage: 'terminal', zero_write: true, data: { allocation_draft_id: id, status: uStatus } };
    }
    // The applied station must be the one that owns the row. Scope identity comes from the STORED header, never
    // from the declaration - the payload cannot assert a station it does not own; it can only fail to match.
    var uScopeKey = [String(uObj.company || ''), String(uObj.country || ''), String(uObj.marketplace || '')].join('|').toLowerCase();
    var wantScopeKey = String((body && body.applied_scope_key) || '').trim().toLowerCase();
    if (wantScopeKey && wantScopeKey !== uScopeKey) {
      return { success: false, error: 'APPLIED_SCOPE_MISMATCH', code: 'APPLIED_SCOPE_MISMATCH', stage: 'validation',
        zero_write: true, data: { allocation_draft_id: id, stored_scope: uScopeKey, applied_scope: wantScopeKey } };
    }
    var uPriorVersion = sadFpVal_(uObj.draft_version);
    if (body && body.expected_draft_version != null && String(body.expected_draft_version).trim() !== '' &&
        sadFpVal_(body.expected_draft_version) !== uPriorVersion) {
      return { success: false, error: 'STALE_OPTIMISTIC_TOKEN', code: 'STALE_OPTIMISTIC_TOKEN', stage: 'conflict',
        zero_write: true, data: { allocation_draft_id: id, expected: sadFpVal_(body.expected_draft_version), current: uPriorVersion } };
    }
    // The destination is exactly one of the two axes, on the POST-UPDATE row. A payload supplying both or
    // neither is refused rather than resolved by precedence - which is the whole lesson of A0-R2/A2.
    var uAfter = sadRowToObject_(sh, found.row);
    ['recommended_source_warehouse_id', 'recommended_destination_warehouse_id',
      'recommended_source_warehouse_code_snapshot', 'recommended_destination_warehouse_code_snapshot',
      'recommendation_group_no', 'recommended_shipping_method', 'recommended_last_mile_delivery',
      'destination_marketplace'].forEach(function (f) {
      if (body && body[f] != null) uAfter[f] = String(body[f]);
    });
    var uDest = sadDestinationIdentity_(uAfter);
    if (!uDest.ok) {
      return { success: false, error: 'ROUTE_DESTINATION_' + String(uDest.code || 'UNRESOLVED'), code: uDest.code || 'ROUTE_DESTINATION_UNRESOLVED',
        stage: 'validation', zero_write: true, data: { allocation_draft_id: id } };
    }
    if (!sadHeaderRouteIsComplete_(uAfter)) {
      return { success: false, error: 'PLAN_HEADER_INCOMPLETE', code: 'PLAN_HEADER_INCOMPLETE', stage: 'validation',
        zero_write: true, data: { allocation_draft_id: id, message: 'the updated route would have no complete From + To + Method (zero rows written)' } };
    }
    // §6 - COLLISION. The frozen K2 contract is that one active header owns one shipment group, so if the
    // post-update key is already held by a DIFFERENT active header the update is refused outright. Nothing is
    // created, nothing is merged, no line is moved, and NEITHER票 is modified - and no authority flag may pick
    // a winner, because choosing which of two real shipments survives is not a decision a writer can make.
    // F1-7N-FB-4G-A2-R3 §B.2 / §I.3 — THE UPDATE COLLISION REFUSAL IS REMOVED, DELIBERATELY.
    //
    // A2-R2 refused an UPDATE that moved a ticket onto a shipment group another active header already held.
    // §B.2 freezes the opposite premise: two tickets with identical From / To / Method are LEGAL, because a
    // ticket's identity is its immutable allocation_draft_id and the K4 key is grouping information only. A
    // state that an explicit Add Route may create cannot be one an edit is forbidden to reach, and keeping the
    // refusal here would also make this writer disagree with the atomic writer about what is persistable.
    //
    // The contender is still COMPUTED and REPORTED on the response, because "another ticket now shares this
    // shape" is worth surfacing — it is just not a refusal, and it is not a merge either.
    var uNewKey = sadK2GroupKey_(uAfter);
    var uContender = '';
    sadReadActiveHeaderRows_(sh).forEach(function (row) {
      if (uContender) return;
      var rid = String(row.allocation_draft_id == null ? '' : row.allocation_draft_id).trim();
      if (!rid || rid === id) return;
      if (sadK2GroupKey_(row) === uNewKey) uContender = rid;
    });
    // §4 - the DETERMINISTIC-ID CHECK IS NOT APPLIED HERE, AND THAT IS THE POINT.
    //
    // sadLegacyReconcileReason_ treats an SADH-K2- id that no longer hashes to its own current field values as
    // a row needing reconciliation. That assumption is now frozen as WRONG (§4): allocation_draft_id names the
    // ENTITY, not its contents, so a legitimately-updated route is EXPECTED to stop hashing to itself. Applying
    // that guard to an explicit UPDATE would classify every legal edit as data corruption - which is exactly
    // what it did. The mismatch is still REPORTED below so a diagnostic can see it; it is no longer a refusal.
    function uSet(name, val) { var c = found.col(name); if (c !== -1) sh.getRange(found.row, c + 1).setValue(val); }
    uSet('status', status);
    ['recommended_source_warehouse_id', 'recommended_destination_warehouse_id',
      'recommended_source_warehouse_code_snapshot', 'recommended_destination_warehouse_code_snapshot',
      'recommendation_group_no', 'recommended_shipping_method', 'recommended_last_mile_delivery',
      'destination_marketplace'].forEach(function (f) {
      if (body && body[f] != null) uSet(f, String(body[f]));
    });
    if (body && body.note != null) uSet('note', String(body.note));
    uSet('draft_version', String(sadFpVal_(uPriorVersion) + 1));
    uSet('updated_by', actor);
    uSet('updated_at', now);
    var uFinal = sadRowToObject_(sh, found.row);
    return jsonResponse_({ success: true, data: { allocation_draft_id: id, updated: true,
      intent: 'UPDATE_EXISTING_ROUTE',
      shares_route_shape_with: uContender || '',
      draft_version: sadFpVal_(uFinal.draft_version),
      route_group_key: sadK2GroupKey_(uFinal),
      persisted_headers: [{ allocation_draft_id: id, route_group_key: sadK2GroupKey_(uFinal),
        resolution: 'UPDATED', status: String(uFinal.status || ''),
        deterministic_group_id: sadK2DeterministicHeaderId_(uFinal),
        // Reported, never enforced (§4): after a legal edit an entity id is EXPECTED not to hash to its own
        // current fields. A diagnostic may surface this; no writer may refuse because of it.
        group_id_matches_stored_id: sadK2DeterministicHeaderId_(uFinal) === String(id).trim() }] } });
  }

  // F1-7N-FA-3C-R6F2A: UNIFIED active-draft resolution (the SAME identity generation uses). Route-complete → K2
  // (CREATE deterministic SADH-K2- id / REUSE / CONFLICT). Route-INCOMPLETE new Draft NEVER creates a K3 header:
  // BLOCK with ROUTE_INCOMPLETE_NEW_DRAFT, or LEGACY_ROUTE_RECONCILIATION_REQUIRED when an existing legacy row matches
  // (unless an explicit USER migration sets allow_legacy_reconcile). draft_version stays version/lineage, not the key.
  // F1-7N-FB-4G-A2-R2 §4/§9 - AN EXPLICIT + Add Route NEVER ADOPTS AN EXISTING HEADER.
  //
  // This was the live failure. The new route's natural key was handed to the resolver below, which matched an
  // existing ROUTE-INCOMPLETE header of the same station (the zero-line H1/H2 shape) and returned REUSE - after
  // which sadLegacyReconcileReason_ refused it with LEGACY_ROUTE_RECONCILIATION_REQUIRED and no new header
  // appeared. The operator asked for a new shipment; the writer went looking for an old one. So a declared
  // CREATE skips the resolver entirely and mints its own identity.
  // F1-7N-FB-4G-A2-R3 §B.2 — THE COLLISION REFUSAL THAT USED TO LIVE HERE IS GONE.
  //
  // A2-R2 refused a create whose shipment group an active header already owned. §B.2 settles that as WRONG: an
  // explicit + Add Route is ALWAYS a new ticket, even with identical From / To / Method, so the K4 key is
  // grouping information and never the entity key. Measured, that refusal blocked a legitimate second click
  // outright — ROUTE_IDENTITY_CONFLICT, zero_write, one header where there should have been two. A declared
  // CREATE therefore never consults the natural-key resolver: no REUSE, no legacy adoption, no refusal.
  //
  // THIS IS NOT THE ROUTE-TICKET PATH, AND IT CANNOT BE. A header written by this call whose line is then
  // refused by the separate upsertShippingAllocationDraftLines call leaves an ORPHAN ZERO-LINE HEADER —
  // measured, 1 header and 0 lines after PLAN_LINE_INCOMPLETE. §D.4 forbids simulating atomicity across two
  // calls, so the Execution Plan writes a route ticket through upsertShippingAllocationDraftAtomic and fails
  // closed when that action is absent rather than falling back here. This path stays available for callers
  // that write a header alone, and it carries NO replay protection: create_idempotency_key is persisted when
  // the column exists, but nothing here can recognise a retry, because a retry of a two-call create may have
  // committed a header this call cannot see the line for. A caller needing that guarantee uses the atomic
  // action, which requires the key and refuses without the column.
  if (sadIntent === 'CREATE_NEW_ROUTE' && hasRouteIntent && status !== 'cancelled') {
    var cDest = sadDestinationIdentity_(body);
    if (!cDest.ok) {
      return { success: false, error: 'ROUTE_DESTINATION_' + String(cDest.code || 'UNRESOLVED'),
        code: cDest.code || 'ROUTE_DESTINATION_UNRESOLVED', stage: 'validation', zero_write: true, data: {} };
    }
    var _cK4Ready = false;
    try { _cK4Ready = sadK4SchemaReady_(sadLiveHeaderNames_(sh)); } catch (eK4) { _cK4Ready = false; }
    id = sadMintNewHeaderId_(sh, body, _cK4Ready);
    if (!id) {
      return { success: false, error: 'ROUTE_IDENTITY_MINT_FAILED', code: 'ROUTE_IDENTITY_MINT_FAILED',
        stage: 'header', zero_write: true, data: {} };
    }
    found = null;
  }

  if (!id) {
    var res = sadResolveActiveDraftK2OrK3_(sh, body, { allowLegacyReconcile: allowReconcile });
    if (res.status === 'CONFLICT') {
      return jsonResponse_({ success: false, error: 'BLOCKED_CONFLICT — more than one Active Draft for this ' + (res.k2 ? 'shipment group (K2)' : 'scope (K3)') + '; resolve manually (zero rows written)', data: { status: 'BLOCKED_CONFLICT', conflictIds: res.conflictIds, k2: res.k2 } });
    }
    if (res.status === 'BLOCK') {
      return jsonResponse_({ success: false, error: res.reason + ' — ' + (res.reason === 'ROUTE_INCOMPLETE_NEW_DRAFT' ? 'a new Draft requires a COMPLETE route (From+To+Method); no K3 header is created for a missing route' : 'this scope has an existing route-incomplete/legacy Draft — reconcile via an explicit USER migration') + ' (zero rows written)', data: { status: res.reason, existing_id: res.id || null } });
    }
    if (res.status === 'REUSE') { id = res.id; found = procurementFindRow_(sh, 'allocation_draft_id', id); }
    else if (res.status === 'CREATE' && res.id) { id = res.id; }   // K2 deterministic id (found stays null → INSERT with it)
  }
  // A: editing an existing route-INCOMPLETE (legacy) row by explicit id is fail-closed unless an explicit USER migration.
  if (found) {
    // FB-4A §D — the REQUEST header is handed to the guard, so the comparison is "is this row my own shipment
    // group?" rather than "does this row's id still hash to itself?". Zero rows are written on a refusal.
    var legR = sadLegacyReconcileReason_(sh, found, allowReconcile, body || null);
    if (legR) return jsonResponse_({ success: false, error: legR + ' — ' + sadReconcileMessage_(legR) + ' (zero rows written)', data: { status: legR, existing_id: id } });
  }

  if (found) {
    function setCol(name, val) { var c = found.col(name); if (c !== -1) sh.getRange(found.row, c + 1).setValue(val); }
    setCol('status', status);
    // header-level route context (recommended_*) — update only when explicitly provided (C2-D1R).
    //
    // F1-7N-FB-4G-A0-R1 — destination_marketplace WAS MISSING FROM THIS LIST, AND THAT IS WHY THE LIVE H4
    // HEADER HOLDS 'Amazon' IN A WAREHOUSE-CODE COLUMN.
    //
    // This function is the writer the Execution Plan actually calls (action upsertShippingAllocationDraft →
    // handleUpsertShippingAllocationDraft_ → here). B4 made destination_marketplace a stored column and B6 put
    // it in the header fingerprint and in the ATOMIC writer's field list — but this two-call writer never read
    // it. So an explicit Amazon save arrived carrying destination_marketplace='Amazon', the field was silently
    // dropped, and the ONLY surviving evidence of the chosen destination was
    // recommended_destination_warehouse_code_snapshot='Amazon' — a marketplace name in a warehouse-code column,
    // which sadStoredHeaderRouteIsComplete_ then read back as the destination so Submit would pass.
    //
    // The client can therefore not stop writing that misuse until this line exists: without it, a correctly
    // XOR'd payload would leave the row with NO destination at all and Submit would refuse it.
    ['recommended_source_warehouse_id', 'recommended_destination_warehouse_id',
      'recommended_source_warehouse_code_snapshot', 'recommended_destination_warehouse_code_snapshot',
      'recommendation_group_no', 'recommended_shipping_method', 'recommended_last_mile_delivery',
      'destination_marketplace'].forEach(function (f) {
      if (body && body[f] != null) setCol(f, String(body[f]));
    });
    if (body && body.calculation_run_id != null) setCol('calculation_run_id', String(body.calculation_run_id));
    if (body && body.calculated_at != null) setCol('calculated_at', String(body.calculated_at));
    if (body && body.source_data_as_of != null) setCol('source_data_as_of', String(body.source_data_as_of));
    if (body && body.note != null) setCol('note', String(body.note));
    setCol('updated_by', actor);
    setCol('updated_at', now);
    // FB-4D §B3 — report the canonical group identity this header now carries, so the client can bind the
    // response to the ROUTE it asked about instead of to whichever save finished last.
    var updObj = sadRowToObject_(sh, found.row);
    return jsonResponse_({ success: true, data: { allocation_draft_id: id, updated: true,
      route_group_key: sadK2GroupKey_(updObj),
      persisted_headers: [{ allocation_draft_id: id, route_group_key: sadK2GroupKey_(updObj),
        resolution: 'UPDATED', status: String(updObj.status || ''),
        deterministic_group_id: sadK2DeterministicHeaderId_(updObj),
        group_id_matches_stored_id: sadK2DeterministicHeaderId_(updObj) === String(id).trim() }] } });
  }

  if (!id) id = 'SAD-' + Utilities.getUuid().substring(0, 10).toUpperCase();
  procurementAppendByHeader_(sh, {
    allocation_draft_id: id,
    planning_cycle: String((body && body.planning_cycle) || '').trim(),
    source_page: String((body && body.source_page) || 'inventory_replenishment').trim(),
    company: String((body && body.company) || '').trim(),
    country: String((body && body.country) || '').trim(),
    marketplace: String((body && body.marketplace) || '').trim(),
    status: status,
    // header-level route context (C2-D1R — recommended_* on the 30-col header)
    recommended_source_warehouse_id: String((body && body.recommended_source_warehouse_id) || '').trim(),
    recommended_destination_warehouse_id: String((body && body.recommended_destination_warehouse_id) || '').trim(),
    recommended_source_warehouse_code_snapshot: String((body && body.recommended_source_warehouse_code_snapshot) || '').trim(),
    recommended_destination_warehouse_code_snapshot: String((body && body.recommended_destination_warehouse_code_snapshot) || '').trim(),
    recommendation_group_no: String((body && body.recommendation_group_no) || '').trim(),
    recommended_shipping_method: String((body && body.recommended_shipping_method) || '').trim(),
    recommended_last_mile_delivery: String((body && body.recommended_last_mile_delivery) || '').trim(),
    // F1-7N-FB-4G-A0-R1 — the same omission on the INSERT path. procurementAppendByHeader_ writes by column
    // NAME, so this is inert on a pre-migration sheet and correct on a migrated one — it needs no deployment
    // ordering of its own. The schema gate above is what makes a pre-migration sheet refuse rather than drop.
    destination_marketplace: String((body && body.destination_marketplace) || '').trim(),
    generation_type: genType,
    calculation_run_id: String((body && body.calculation_run_id) || '').trim(),
    formula_version: String((body && body.formula_version) || '').trim(),
    calculated_at: String((body && body.calculated_at) || '').trim(),
    source_data_as_of: String((body && body.source_data_as_of) || '').trim(),
    draft_version: draftVersion,
    created_by: actor, created_at: now, updated_by: actor, updated_at: now,
    submitted_by: '', submitted_at: '', cancelled_by: '', cancelled_at: '', cancel_reason: '',
    note: String((body && body.note) || '').trim()
  });
  var newObj = procurementFindRow_(sh, 'allocation_draft_id', id);
  var newGroupKey = newObj ? sadK2GroupKey_(sadRowToObject_(sh, newObj.row)) : '';
  return jsonResponse_({ success: true, data: { allocation_draft_id: id, created: true,
    route_group_key: newGroupKey,
    persisted_headers: [{ allocation_draft_id: id, route_group_key: newGroupKey, resolution: 'CREATED',
      status: status, deterministic_group_id: id, group_id_matches_stored_id: true }] } });
}

// ---- upsertShippingAllocationDraftLines ---------------------------
/**
 * UPSERT lines by allocation_draft_line_id (NOT a blanket replace — that would wipe the immutable
 * recommendation snapshot). Body:
 *   { allocation_draft_id, lines: [ { allocation_draft_line_id?, sku, site_sku?, planned_qty?,
 *     recommended_qty?, route_no?, units_per_carton?, override_reason?, note?, line_status?,
 *     calculated_gap_qty?, window_code?, required_by_date?, ... } ] }
 *   (C2-D1R: route context — From/To/Method — is HEADER-level; the 28-col line carries SKU + qty only.
 *    legacy source_available_qty_snapshot is accepted as a read-only alias via sadApplyLineAliases_.)
 * Rules (§D quantity protection):
 *   - Existing line (id matches): update planned_qty + Execution-Plan fields always; update a
 *     recommendation-snapshot field ONLY if the incoming line supplies it (else preserved).
 *   - New line: append; if planned_qty omitted, initialize planned_qty = recommended_qty.
 * MUST NOT persist uncovered_qty / coverage_status / window_label / display strings (§C).
 * Returns { line_count, created, updated }.
 */
// Round 1H enforcement: PUBLIC shipping-lines route now acquires the ScriptLock + header terminal-guard before
// delegating to the (private) keyed (allocation_draft_line_id) upsert core, which additionally skips any
// line-terminal row. Shipping remains DEPLOYMENT-GATED (source-mirror scaffold); full optimistic-token + KMUE
// natural-key unification for shipping is a documented pending item (the live procurement path uses KMUE today).
function handleUpsertShippingAllocationDraftLines_(body) {
  var lock = LockService.getScriptLock();
  try { if (!lock.tryLock(30000)) return jsonResponse_({ success: false, error: 'Could not acquire lock; please retry.', stage: 'lock' }); }
  catch (e) { return jsonResponse_({ success: false, error: 'Lock error: ' + (e && e.message ? e.message : e), stage: 'lock' }); }
  try {
    var ss0 = SpreadsheetApp.getActiveSpreadsheet();
    var did = String((body && body.allocation_draft_id) || '').trim();
    if (did) {
      var hsh = procurementEnsureSheet_(ss0, 'shipping_allocation_drafts', SHIPPING_ALLOCATION_DRAFTS_HEADERS_);
      var hf = procurementFindRow_(hsh, 'allocation_draft_id', did);
      if (hf) { var cs = hf.col('status'); var stt = cs !== -1 ? String(hsh.getRange(hf.row, cs + 1).getValue()).trim().toLowerCase() : ''; if (SAD_TERMINAL_STATUSES_[stt]) return jsonResponse_({ success: false, error: 'IMMUTABLE_TERMINAL_STATUS:' + stt, stage: 'terminal' }); }
    }
    return sadUpsertLinesKeyedCore_(body);
  } finally { try { lock.releaseLock(); } catch (e2) { /* best-effort release */ } }
}

// F1-7N-FA-3C-R6F — GENERATED_LINE_ID reconciliation. The KMPR generate path (bundled core, via 61_) writes each
// AI-Plan line keyed ONLY by its natural key (sku|site_sku|window_code|source_warehouse_id|route_no within one
// allocation_draft_id — mirrors KMPR TABLES.WEEKLY_SHIPPING.lineKey) and leaves `allocation_draft_line_id` BLANK.
// The frontend Save path here keys by `allocation_draft_line_id`, so a generated line edited from the UI used to
// append a DUPLICATE (no id match → INSERT). These helpers let this path (a) find the existing generated row by its
// natural key when the incoming id is blank, and (b) mint a DETERMINISTIC id so the SAME logical line always resolves
// to the SAME id (no random-UUID drift). FROZEN id formula:
//   allocation_draft_line_id = 'SADL-' + upper(FNV1a-hex( allocation_draft_id|sku|site_sku|window_code|source_warehouse_id|route_no ))
// All lowercased/trimmed. No live DB access here — pure over the row + a single sheet scan under the caller's lock.
function sadLineNaturalKey_(draftId, l) {
  function s(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  return [s(draftId), s(l.sku), s(l.site_sku), s(l.window_code), s(l.source_warehouse_id), s(l.route_no)].join('|');
}
function sadFnv1a_(str) { var h = 0x811c9dc5; str = String(str); for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ('00000000' + h.toString(16)).slice(-8); }
function sadDeterministicLineId_(draftId, l) { return 'SADL-' + sadFnv1a_(sadLineNaturalKey_(draftId, l)).toUpperCase(); }
// Scan the lines sheet for an existing row matching the natural key within draftId. Returns a procurementFindRow_-shaped
// { row (1-based), col(name) } or null. Used ONLY when the incoming line has no explicit allocation_draft_line_id.
function sadFindLineByNaturalKey_(sh, draftId, l) {
  var data = sh.getDataRange().getValues();
  if (!data || data.length < 2) return null;
  var headers = data[0].map(function (h) { return String(h).trim(); });
  function idx(n) { return headers.indexOf(n); }
  var cDraft = idx('allocation_draft_id'), cSku = idx('sku');
  if (cDraft === -1 || cSku === -1) return null;
  var cSite = idx('site_sku'), cWin = idx('window_code'), cSrc = idx('source_warehouse_id'), cRoute = idx('route_no');
  function s(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  var want = sadLineNaturalKey_(draftId, l);
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var nk = [s(row[cDraft]), s(row[cSku]), cSite === -1 ? '' : s(row[cSite]), cWin === -1 ? '' : s(row[cWin]),
      cSrc === -1 ? '' : s(row[cSrc]), cRoute === -1 ? '' : s(row[cRoute])].join('|');
    if (nk === want) return { row: r + 1, col: function (n) { return idx(n); } };
  }
  return null;
}

// ================================================================================================================
// F1-7N-FA-3C-R6F1 — K2 SHIPMENT-GROUP CONTRACT (FROZEN, DETERMINISTIC MACHINERY — NOT LIVE-WIRED THIS ROUND)
// ----------------------------------------------------------------------------------------------------------------
// The latest USER business decision supersedes the Phase-1 K3 freeze: ONE shipping_allocation_drafts Header ==
// ONE shipment group sharing the 10-dimension route grouping key below. Different source warehouse / destination /
// shipping method / last-mile / recommendation_group_no => a SEPARATE Header. Lines carry SKU + window (+ their own
// route evidence) UNDER that Header. A Header must never contain lines with incompatible route grouping values.
//
// These are the FROZEN, TESTED contract functions (key · deterministic Header id · deterministic Line id ·
// CREATE/REUSE/CONFLICT · incompatible-route guard · split/regroup). They are DELIBERATELY NOT wired into the live
// active-draft resolution: the live save path keeps resolving on the landed K3 scope (sadResolveActiveDraft_) so the
// current save<->generation key AGREEMENT is preserved. LIVE K2 ACTIVATION IS HALTED — the bundled AI-Plan generation
// engine (KMWRB/KMPB/KMPPB) does NOT derive four of the ten K2 dimensions (recommended_shipping_method,
// recommended_last_mile_delivery, recommended_destination_warehouse_id, recommendation_group_no are BLANK at
// generation; grep-verified). Grouping on blank dims would collapse every route into ONE group. Activation requires
// the Route-Derivation Input Matrix (design-freeze §45) + INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ flip + live
// verification — all USER-owned. Until then: K2_CONTRACT_AND_MACHINERY_READY = YES · K2_LIVE_GENERATION_ACTIVATED = NO.

// The 10 canonical K2 grouping dimensions, in frozen order. Route context is HEADER-level (read from recommended_*).
// F1-7N-FB-4D §E — deployment build stamp for the ALLOCATION HANDLER OWNER. Probed by system.health so a
// half-finished file-by-file Apps Script sync is a NAMED fact rather than a mystery: every action in this file
// still resolves when the file is a round behind, so a resolvable action list cannot detect it. FB-4D changed
// this file (the pre-write duplicate-PK gate and the route-group keys on the write response).
// F1-7N-FC-1B-E3-R4-A2-R1-R5 §10 — also never rotated. This file last changed in
// F1-7N-FC-1B-E3-R4-A2-R1-R2; the label was left at the round before that.
// R6-R6-R4-R2 — moved because THIS FILE changed: an UPDATE_EXISTING_ROUTE that declares no
// expected_draft_version is now MISSING_OPTIMISTIC_TOKEN with zero rows written, and the documented
// top-level field is finally read. A stamp records the round a module last changed; it is not the release.
var SAD_BUILD_VERSION_ = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4-R2';

var SAD_K2_GROUP_DIMENSIONS_ = ['planning_cycle', 'company', 'country', 'marketplace', 'source_page',
  'recommended_source_warehouse_id', 'recommended_destination_warehouse_id',
  'recommended_shipping_method', 'recommended_last_mile_delivery', 'recommendation_group_no'];

// Canonical K2 group key from a header-shaped object. Trimmed + lowercased, '|'-joined in the frozen dim order.
// Accepts either the persisted recommended_* names OR the short route aliases (source_warehouse_id /
// destination_warehouse_id / shipping_method / last_mile_delivery) so a caller can key off either shape.
function sadK2GroupKey_(h) {
  h = h || {};
  function s(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  function pick(canon, alias) { var a = h[canon]; if (a == null || a === '') a = h[alias]; return s(a); }
  return [s(h.planning_cycle), s(h.company), s(h.country), s(h.marketplace), s(h.source_page || 'inventory_replenishment'),
    pick('recommended_source_warehouse_id', 'source_warehouse_id'),
    pick('recommended_destination_warehouse_id', 'destination_warehouse_id'),
    pick('recommended_shipping_method', 'shipping_method'),
    pick('recommended_last_mile_delivery', 'last_mile_delivery'),
    s(h.recommendation_group_no)].join('|');
}
// Deterministic K2 Header id: SADH-K2-<upper FNV1a hex of the K2 group key>. Same shipment group => same id (stable).
function sadK2DeterministicHeaderId_(h) { return 'SADH-K2-' + sadFnv1a_(sadK2GroupKey_(h)).toUpperCase(); }

// K2 LINE natural key: sku + site_sku + window_code ONLY (source/route are HEADER dims under K2, not line identity).
function sadK2LineNaturalKey_(draftId, l) {
  function s(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  l = l || {};
  return [s(draftId), s(l.sku), s(l.site_sku), s(l.window_code)].join('|');
}
// Deterministic K2 LINE id: SADL-K2-<upper FNV1a hex of the K2 line natural key>.
function sadK2DeterministicLineId_(draftId, l) { return 'SADL-K2-' + sadFnv1a_(sadK2LineNaturalKey_(draftId, l)).toUpperCase(); }

// F1-7N-FA-3C-R6F2G (B) — K2-AWARE NEW-LINE id authority (wired into the atomic writer below; PERMANENT fix for the
// R6F2F2 freeze/writer divergence where a K2 CREATE minted generic SADL- ids while the freeze precomputed SADL-K2-).
// A genuine K2 shipment group mints the K2 line id (SADL-K2-, natural key sku|site_sku|window_code); a generic/legacy
// draft keeps the SADL- scheme (natural key sku|site_sku|window_code|source_warehouse_id|route_no). K2 CREATE and the
// missing-line REGENERATE path use the SAME K2 authority. `sadIsK2Group_` classifies from the GROUP authority — the
// resolver's k2 decision when known, else the header's route completeness (the exact predicate the K2 resolver uses),
// corroborated by (never solely decided by) a stored SADH-K2- id — so a caller-supplied prefix alone can never
// reclassify a draft. For a K2 CREATE the new-line id is ALWAYS derived from the canonical K2 natural key, so a
// caller-supplied arbitrary line id is never trusted to name a new K2 line.
function sadIsK2Group_(resolvedK2, headerId, header) {
  if (resolvedK2 === true) return true;
  if (resolvedK2 === false && !(String(headerId || '').indexOf('SADH-K2-') === 0)) return false;
  return (String(headerId || '').indexOf('SADH-K2-') === 0) || sadHeaderRouteIsComplete_(header || {});
}
function sadNewLineId_(isK2, draftId, l) { return isK2 ? sadK2DeterministicLineId_(draftId, l) : sadDeterministicLineId_(draftId, l); }

// CREATE / REUSE / CONFLICT over the K2 group key among ACTIVE headers (draft/site_confirmed/partially_submitted).
// rows = header-shaped objects (each carrying allocation_draft_id + the K2 dims + status). Pure; no sheet access.
//   0 active match => CREATE (deterministic id) · 1 => REUSE (that id) · >1 => BLOCKED_CONFLICT (all ids; zero mutation).
function sadK2ResolveActiveDraft_(rows, wantHeader) {
  var ACTIVE = { draft: 1, site_confirmed: 1, partially_submitted: 1 };
  var want = sadK2GroupKey_(wantHeader), matches = [];
  (rows || []).forEach(function (r) {
    if (!ACTIVE[String(r && r.status == null ? '' : r.status).trim().toLowerCase()]) return;
    if (sadK2GroupKey_(r) === want) matches.push(String(r.allocation_draft_id == null ? '' : r.allocation_draft_id).trim());
  });
  if (matches.length === 0) return { status: 'CREATE', k2Key: want, allocation_draft_id: sadK2DeterministicHeaderId_(wantHeader) };
  if (matches.length === 1) return { status: 'REUSE', k2Key: want, allocation_draft_id: matches[0] };
  return { status: 'BLOCKED_CONFLICT', k2Key: want, conflictIds: matches };
}

// Incompatible-route guard: EVERY line's route grouping values must match the Header's shipment group. A line whose
// source/destination/method/last-mile/group_no differs from the Header belongs under a DIFFERENT K2 Header. A line
// that OMITS a dim inherits the Header (blank line dim is NOT a violation). Pure. Returns
// { compatible, violations:[{ index, field, headerValue, lineValue }] }.
function sadK2LinesRouteCompatibleWithHeader_(headerRow, lines) {
  function s(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  headerRow = headerRow || {};
  var dims = [
    ['recommended_source_warehouse_id', 'source_warehouse_id'],
    ['recommended_destination_warehouse_id', 'destination_warehouse_id'],
    ['recommended_shipping_method', 'shipping_method'],
    ['recommended_last_mile_delivery', 'last_mile_delivery'],
    ['recommendation_group_no', 'recommendation_group_no']
  ];
  var violations = [];
  (lines || []).forEach(function (l, i) {
    l = l || {};
    dims.forEach(function (d) {
      var lv = l[d[1]]; if (lv == null || lv === '') return;              // omitted => inherits header (not a violation)
      var hv = s(headerRow[d[0]]);
      if (s(lv) !== hv) violations.push({ index: i, field: d[1], headerValue: hv, lineValue: s(lv) });
    });
  });
  return { compatible: violations.length === 0, violations: violations };
}

// SPLIT / REGROUP: partition a flat set of route-bearing lines into K2 group buckets keyed by each line's own route
// dims. Each bucket => ONE K2 Header (deterministic id from the bucket route). This is the frozen regroup contract for
// when route fields change: a re-grouping NEVER merges incompatible routes into one Header. Pure. Returns an ordered
// [{ k2Key, allocation_draft_id, header, lines }].
function sadK2PartitionLinesIntoGroups_(scope, lines) {
  scope = scope || {};
  var buckets = {}, order = [];
  (lines || []).forEach(function (l) {
    l = l || {};
    var header = {
      planning_cycle: scope.planning_cycle, company: scope.company, country: scope.country,
      marketplace: scope.marketplace, source_page: scope.source_page,
      recommended_source_warehouse_id: l.source_warehouse_id, recommended_destination_warehouse_id: l.destination_warehouse_id,
      recommended_shipping_method: l.shipping_method, recommended_last_mile_delivery: l.last_mile_delivery,
      recommendation_group_no: l.recommendation_group_no
    };
    var key = sadK2GroupKey_(header);
    if (!buckets[key]) { buckets[key] = { k2Key: key, allocation_draft_id: sadK2DeterministicHeaderId_(header), header: header, lines: [] }; order.push(key); }
    buckets[key].lines.push(l);
  });
  return order.map(function (k) { return buckets[k]; });
}
// ================================================================================================================

// ================================================================================================================
// F1-7N-FA-3C-R6F2A (B/C) — payload fingerprint (REUSE vs REGENERATE) + user-edit ownership rule.
// Fingerprint covers the persisted BUSINESS fields (header route + status + each line's business fields, natural-key
// sorted); it EXCLUDES server ids / audit / draft_version. Equal fingerprint ⇒ REUSE (zero writes); different +
// editable ⇒ REGENERATE (update + draft_version++ once + adopt new calc evidence).
var SAD_K2_HEADER_FP_ = ['status', 'recommended_source_warehouse_id', 'recommended_destination_warehouse_id',
  'recommended_source_warehouse_code_snapshot', 'recommended_destination_warehouse_code_snapshot',
  'recommendation_group_no', 'recommended_shipping_method', 'recommended_last_mile_delivery',
  // F1-7N-FB-4F-B6 - THE DESTINATION MUST MAKE A DIFFERENCE, for exactly the reason the ETA had to.
  // Giving a destination-less legacy header its first destination changes NOTHING ELSE: same source, same
  // service, same status, same quantity. With destination_marketplace outside the fingerprint the prior and
  // incoming payloads compared EQUAL, the writer returned REUSE with zero_write, and the operator was told the
  // save succeeded while the column stayed blank - a silent no-op on the one field the whole round is about.
  // Adding a field both sides leave blank changes nothing for any other row: the fingerprint is computed per
  // request from both sides, never stored, so no id and no existing row is affected.
  'destination_marketplace'];
var SAD_K2_LINE_FP_ = ['sku', 'site_sku', 'window_code', 'window_start_date', 'window_end_date', 'required_by_date',
  'regular_demand_snapshot', 'special_event_demand_snapshot', 'destination_stock_snapshot', 'qualified_incoming_snapshot',
  'approved_supply_snapshot', 'calculated_gap_qty', 'source_initial_available_qty_snapshot',
  'source_available_before_allocation_snapshot', 'allocation_sequence', 'recommendation_reason', 'recommendation_flags',
  'recommended_qty', 'source_warehouse_id', 'source_warehouse_code_snapshot', 'planned_qty', 'units_per_carton',
  'route_no', 'line_status',
  // F1-7N-FB-4F-B3 - the ETA must make a difference, or an ETA-only edit is read as "no change" and dropped.
  'expected_arrival'];
function sadFpVal_(v) { return String(v == null ? '' : v).trim(); }
function sadK2PayloadFingerprint_(headerObj, linesArr) {
  headerObj = headerObj || {};
  var h = SAD_K2_HEADER_FP_.map(function (f) { return f + '=' + sadFpVal_(headerObj[f]); }).join('|');
  var ls = (linesArr || []).map(function (l) { return SAD_K2_LINE_FP_.map(function (f) { return sadFpVal_(l[f]); }).join('~'); });
  ls.sort();
  return 'k2fp-' + sadFnv1a_(h + '||' + ls.join('||')).toUpperCase();
}

// F1-7N-FA-3C-R6F2G6 — TRUE zero-write REUSE. The raw fingerprint above compares sadFpVal_ (plain String().trim()) of
// each FP field. A persisted cell that Google Sheets coerces (a DATE field read back as a Date object vs an incoming
// 'yyyy-MM-dd' string; a number vs its numeric string; decimal/format noise) makes priorFp !== incFp even when the
// business content is byte/semantically identical — so the atomic writer took the REGENERATE branch (physical in-place
// setValue on the header route/lineage + draft_version++ + every line's updated_at) at row-count delta 0/0, and the
// controlled retry reported REGENERATED instead of a true no-op. sadK2SemanticPayloadEqual_ re-compares the SAME FP
// fields through a canonical, representation-robust normalizer so a representation-only difference is recognised as a
// no-op (REUSE, zero write). It NEVER collapses a genuine value change (dates to day granularity, numbers to canonical
// numeric form, strings trimmed), so legitimate user-directed MANUAL_REGENERATE for a changed payload is unaffected.
var SAD_K2_FP_DATE_FIELDS_ = { window_start_date: 1, window_end_date: 1, required_by_date: 1 };
var SAD_K2_FP_NUMERIC_FIELDS_ = { recommendation_group_no: 1, regular_demand_snapshot: 1, special_event_demand_snapshot: 1,
  destination_stock_snapshot: 1, qualified_incoming_snapshot: 1, approved_supply_snapshot: 1, calculated_gap_qty: 1,
  source_initial_available_qty_snapshot: 1, source_available_before_allocation_snapshot: 1, allocation_sequence: 1,
  recommended_qty: 1, planned_qty: 1, units_per_carton: 1 };
function sadCanonDate_(v) {
  if (v == null || v === '') return '';
  function z(x) { return ('0' + x).slice(-2); }
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    var d = new Date(v.getTime() + 8 * 3600000);              // project tz Asia/Taipei (UTC+8) calendar date
    return d.getUTCFullYear() + '-' + z(d.getUTCMonth() + 1) + '-' + z(d.getUTCDate());
  }
  var s = String(v).trim(); var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  var dt = new Date(s); if (!isNaN(dt.getTime())) { var d2 = new Date(dt.getTime() + 8 * 3600000); return d2.getUTCFullYear() + '-' + z(d2.getUTCMonth() + 1) + '-' + z(d2.getUTCDate()); }
  return s;
}
function sadFpNorm_(field, value) {
  if (SAD_K2_FP_DATE_FIELDS_[field]) return sadCanonDate_(value);
  if (SAD_K2_FP_NUMERIC_FIELDS_[field]) { var s = String(value == null ? '' : value).trim(); if (s === '') return ''; var n = Number(s); return isFinite(n) ? String(n) : s; }
  return String(value == null ? '' : value).trim();
}
// F1-7N-FA-3C-R6F2G7A — the SEMANTIC-equivalence comparator (contract SAD_K2_SEM_CONTRACT_) used by the atomic REUSE
// branch AND by the read-only live authority summary/diagnostic (exactly the same comparator). It answers "would a
// REGENERATE change any persisted BUSINESS field?" It is representation-robust (R6F2G6 dates/numerics) and truthful to
// the writer's omit/default/preserve semantics — WITHOUT a wildcard "blank incoming → preserve". Every FP field belongs
// to exactly ONE explicit, frozen class:
//   1. EXCLUDED_LIFECYCLE (status, line_status) — audit/lifecycle fields the K2 payload authority (KMWRR) never emits and
//      regeneration does not treat as content (line_status is not patched by sadRegenerateLinePatch_; header status is
//      reset to 'draft' by the writer). EXCLUDED from equality and PRESERVED on REUSE (write-free, strictly safer than
//      REGENERATE). This was the exact R6F2G6→live false negative.
//   2. OPTIONAL_PRESERVE — business fields PROVEN optional from the writer contract: (a) buildGroupHeader /
//      buildK2GenerationPlan (KMWRR) structurally OMIT them from the regeneration payload (the K2 header carries no
//      recommended_*_warehouse_code_snapshot; the K2 line carries only sku/site_sku/window*/required_by_date/
//      source_warehouse_id/source_warehouse_code_snapshot/planned_qty/recommended_qty/units_per_carton — NOT the demand/
//      stock/gap/supply/allocation snapshots, recommendation_reason/flags, or the line route_no), and (b) the writer
//      patches them ONLY when the incoming provides them nonblank (SAD_RECOMMENDATION_FIELDS_ line patch + the header
//      code-snapshot / route-context patch), so an OMITTED incoming CANNOT change the stored cell. A regeneration
//      therefore can never alter these — an omitted incoming is a true no-op (equal); a NONBLANK incoming that differs
//      is still a real change (compared). This whitelist is EXPLICIT — no wildcard/default.
//   3. REQUIRED_OR_STRICT — everything else: identity/SKU/site-SKU/membership, quantity, window, route method/last-mile,
//      warehouse and group authorities KMWRR ALWAYS emits. Incoming blank equals stored blank ONLY; incoming blank with
//      stored nonblank is a MISSING_REQUIRED_INCOMING_FIELD (a blocking difference, never a silent preserve). Zero/false
//      are real NONBLANK values (blank≠zero, blank≠false); a nonblank unparseable numeric/date is UNKNOWN_UNPARSEABLE.
//   Lines are matched by K2 identity (sku|site_sku|window_code); membership must be EXACT (missing/extra ⇒ not equal).
var SAD_K2_SEM_CONTRACT_ = 'R6F2G7A-SEM-V3';
var SAD_K2_SEM_EXCLUDED_LIFECYCLE_ = { status: 1, line_status: 1 };
var SAD_K2_SEM_OPTIONAL_PRESERVE_ = { recommended_source_warehouse_code_snapshot: 1, recommended_destination_warehouse_code_snapshot: 1, regular_demand_snapshot: 1, special_event_demand_snapshot: 1, destination_stock_snapshot: 1, qualified_incoming_snapshot: 1, approved_supply_snapshot: 1, calculated_gap_qty: 1, source_initial_available_qty_snapshot: 1, source_available_before_allocation_snapshot: 1, allocation_sequence: 1, recommendation_reason: 1, recommendation_flags: 1, route_no: 1 };
// back-compat alias (identical membership) for the R6F2G6/G7 excluded-set name still referenced by the diagnostics.
var SAD_K2_SEM_EXCLUDE_ = { status: 1, line_status: 1 };
function sadK2SemFieldClass_(field) { if (SAD_K2_SEM_EXCLUDED_LIFECYCLE_[field]) return 'EXCLUDED_LIFECYCLE'; if (SAD_K2_SEM_OPTIONAL_PRESERVE_[field]) return 'OPTIONAL_PRESERVE'; return 'REQUIRED_OR_STRICT'; }
function sadK2LineIdentity_(l) { function s(v) { return String(v == null ? '' : v).trim().toLowerCase(); } l = l || {}; return s(l.sku) + '|' + s(l.site_sku) + '|' + s(l.window_code); }
// per-FP-field semantic verdict under the R6F2G7A contract → { equal, category, blocking }. categories: EXCLUDED_LIFECYCLE
// | BOTH_BLANK | OPTIONAL_PRESERVE_OMITTED | EQUAL | DATE_REPRESENTATION_EQUAL | NUMERIC_REPRESENTATION_EQUAL |
// MISSING_REQUIRED_INCOMING_FIELD | UNKNOWN_UNPARSEABLE | TRUE_BUSINESS_DIFFERENCE.
function sadK2SemFieldVerdict_(field, storedVal, incVal) {
  if (sadK2SemFieldClass_(field) === 'EXCLUDED_LIFECYCLE') return { equal: true, category: 'EXCLUDED_LIFECYCLE', blocking: false };
  var sBlank = String(storedVal == null ? '' : storedVal).trim() === '';
  var iBlank = String(incVal == null ? '' : incVal).trim() === '';
  if (iBlank) {
    if (sBlank) return { equal: true, category: 'BOTH_BLANK', blocking: false };                                  // both empty → no change
    if (sadK2SemFieldClass_(field) === 'OPTIONAL_PRESERVE') return { equal: true, category: 'OPTIONAL_PRESERVE_OMITTED', blocking: false };  // writer preserves; KMWRR omits
    return { equal: false, category: 'MISSING_REQUIRED_INCOMING_FIELD', blocking: true };                         // required authority vanished from the payload
  }
  // incoming NONBLANK (a provided 0 / false is compared) → canonical comparison; fail closed on an unparseable value
  if (SAD_K2_FP_NUMERIC_FIELDS_[field]) { if (!isFinite(Number(String(incVal).trim()))) return { equal: false, category: 'UNKNOWN_UNPARSEABLE', blocking: true }; if (!sBlank && !isFinite(Number(String(storedVal).trim()))) return { equal: false, category: 'UNKNOWN_UNPARSEABLE', blocking: true }; }
  if (SAD_K2_FP_DATE_FIELDS_[field]) { if (!/^\d{4}-\d\d-\d\d$/.test(sadCanonDate_(incVal))) return { equal: false, category: 'UNKNOWN_UNPARSEABLE', blocking: true }; if (!sBlank && !/^\d{4}-\d\d-\d\d$/.test(sadCanonDate_(storedVal))) return { equal: false, category: 'UNKNOWN_UNPARSEABLE', blocking: true }; }
  if (sadFpNorm_(field, storedVal) !== sadFpNorm_(field, incVal)) return { equal: false, category: 'TRUE_BUSINESS_DIFFERENCE', blocking: true };
  if (SAD_K2_FP_DATE_FIELDS_[field] && String(storedVal == null ? '' : storedVal).trim() !== String(incVal).trim()) return { equal: true, category: 'DATE_REPRESENTATION_EQUAL', blocking: false };
  if (SAD_K2_FP_NUMERIC_FIELDS_[field] && String(storedVal == null ? '' : storedVal).trim() !== String(incVal).trim()) return { equal: true, category: 'NUMERIC_REPRESENTATION_EQUAL', blocking: false };
  return { equal: true, category: 'EQUAL', blocking: false };
}
function sadK2SemFieldEqual_(field, storedVal, incVal) { return sadK2SemFieldVerdict_(field, storedVal, incVal).equal; }
function sadK2SemanticPayloadEqual_(hPrior, lPrior, hInc, lInc) {
  hPrior = hPrior || {}; hInc = hInc || {};
  for (var i = 0; i < SAD_K2_HEADER_FP_.length; i++) { var f = SAD_K2_HEADER_FP_[i]; if (!sadK2SemFieldEqual_(f, hPrior[f], hInc[f])) return false; }
  var pById = {}, iById = {};
  (lPrior || []).forEach(function (l) { pById[sadK2LineIdentity_(l)] = l; });
  (lInc || []).forEach(function (l) { iById[sadK2LineIdentity_(l)] = l; });
  var pk = Object.keys(pById).sort(), ik = Object.keys(iById).sort();
  if (pk.length !== ik.length) return false;
  for (var k = 0; k < pk.length; k++) if (pk[k] !== ik[k]) return false;
  for (var m = 0; m < pk.length; m++) { var sp = pById[pk[m]], si = iById[pk[m]]; for (var j = 0; j < SAD_K2_LINE_FP_.length; j++) { var lf = SAD_K2_LINE_FP_[j]; if (!sadK2SemFieldEqual_(lf, sp[lf], si[lf])) return false; } }
  return true;
}

// C — user-edit ownership: given the EXISTING persisted line + the incoming (regenerated) line, decide the fields to
// write on REGENERATE. recommended_qty + calculation snapshots = SYSTEM-owned (always adopt). note = USER-owned
// (preserved — a regeneration never restores an old AI note). planned_qty = USER-owned when override_reason is nonblank
// OR planned_qty differs from the PRIOR recommended_qty; otherwise it follows the newly regenerated recommended_qty.
// route/source/units are system route context. Returns a { field: value } patch to setValue on the existing row.
function sadRegenerateLinePatch_(existing, incoming) {
  existing = existing || {}; incoming = incoming || {};
  var patch = {};
  // system-owned: recommended_qty + snapshots + route context
  SAD_RECOMMENDATION_FIELDS_.forEach(function (f) { if (incoming[f] != null && incoming[f] !== '') patch[f] = String(incoming[f]); });
  ['route_no', 'units_per_carton', 'source_warehouse_id', 'source_warehouse_code_snapshot'].forEach(function (f) { if (incoming[f] != null) patch[f] = String(incoming[f]); });
  // planned_qty ownership
  var priorRec = sadFpVal_(existing.recommended_qty);
  var priorPlanned = sadFpVal_(existing.planned_qty);
  var overridden = sadFpVal_(existing.override_reason) !== '' || (priorPlanned !== '' && priorPlanned !== priorRec);
  if (!overridden) {
    var newRec = (incoming.recommended_qty != null && incoming.recommended_qty !== '') ? String(incoming.recommended_qty) : priorRec;
    patch.planned_qty = newRec;                                    // follows the new recommendation
  } // else: preserve the user's planned_qty (omit → no write)
  // note is USER-owned → never overwritten by regeneration (omit)
  // F1-7N-FB-4F-B3 - expected_arrival is USER-SUPPLIED, and adopted ONLY when the save actually supplies one.
  // A blank incoming ETA is omitted rather than written, so regeneration can never blank a date the operator
  // set, and the server never reconstructs one it was not given. Existing lines stay blank until an
  // authoritative save carries a value.
  if (incoming.expected_arrival != null && String(incoming.expected_arrival).trim() !== '') {
    patch.expected_arrival = String(incoming.expected_arrival).trim();
  }
  return patch;
}

// Private keyed shipping-line upsert core (reached ONLY under lock via the public handler above).
// ================================================================================================================
// F1-7N-FB-4B §B — LINE IDENTITY IS CANONICAL, NOT WHATEVER OPAQUE ID THE CALLER HAPPENS TO HOLD.
//
// THE LIVE CORRUPTION, AND EXACTLY HOW IT WAS PRODUCED. Three physical rows appeared with the SAME primary key
// (SADL-K2-16F4E4F9 under SADH-K2-E7AF9242, CO1100-R, planned_qty 800, created 11:18:11 / 11:19:53 / 11:20:07).
// The mechanism is a closed loop between two half-correct pieces:
//
//   1. The page mints a CLIENT-SIDE line id for a new route — _newDraftLineId() returns
//      'SADL-' + Math.random()... — and stores it on the row element.
//   2. This writer, for a K2 draft, DISCARDS that id and mints the canonical SADL-K2-<hash> instead
//      (R6F2G, deliberately: an arbitrary caller id must never name a K2 line).
//   3. The response never returned the id it actually persisted, and the page never adopted one.
//   4. So the NEXT save sent the same client-side id again. procurementFindRow_ did not find it (the stored row
//      carries the K2 id), the code fell into the INSERT branch, minted the SAME canonical id a second time —
//      and appended, because nothing checked whether that minted id already existed.
//
// Every subsequent save of the same logical line appended one more physical row. Three saves, three rows.
//
// THE FIX IS TO STOP TREATING THE CALLER'S ID AS AN IDENTITY. A line's identity is its CANONICAL identity:
// under K2 the deterministic SADL-K2- id (sku|site_sku|window_code within the draft — route and source are HEADER
// dimensions by the frozen K2 contract), otherwise the deterministic SADL- natural key. An opaque id the caller
// happens to be holding is at most a HINT. Resolution order is therefore:
//   a) explicit id that resolves to a row — but only if that row's canonical identity MATCHES the incoming line,
//      otherwise the caller is trying to rename a line's identity, which fails closed;
//   b) the CANONICAL id;
//   c) the natural-key scan (a generated line whose id column is still blank);
//   d) only then INSERT — and even then the canonical id is asserted absent first.
//
// This is what makes a retry converge on ONE row instead of appending another.
var SAD_LINE_IDENTITY_FIELDS_ = ['sku', 'site_sku', 'window_code'];

// The canonical identity of an incoming line under a given draft. Pure.
function sadCanonicalLineId_(isK2, draftId, l) {
  return isK2 ? sadK2DeterministicLineId_(draftId, l) : sadDeterministicLineId_(draftId, l);
}

// Do two rows describe the SAME logical line? Compared on the identity fields only — quantities and notes are
// CONTENT, and content changing is an edit, not a different line.
function sadSameLineIdentity_(a, b) {
  function s(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  for (var i = 0; i < SAD_LINE_IDENTITY_FIELDS_.length; i++) {
    var f = SAD_LINE_IDENTITY_FIELDS_[i];
    if (s((a || {})[f]) !== s((b || {})[f])) return false;
  }
  return true;
}

// PURE batch pre-flight, run BEFORE any write so a rejection is a proven zero-write.
// Two incoming lines that resolve to the SAME canonical identity cannot both be persisted: under the frozen K2
// contract a Header holds ONE line per (sku, site_sku, window_code), because route and source are HEADER
// dimensions. Two routes for one SKU are therefore either the SAME line (same route group) or belong under
// DIFFERENT headers (different route group) — never two lines under one header. Silently letting the second
// overwrite the first would destroy the operator's first quantity, so it fails closed and names both.
function sadPreflightLineBatch_(isK2, draftId, lines) {
  var byId = {}, conflicts = [];
  for (var i = 0; i < (lines || []).length; i++) {
    var l = lines[i] || {};
    if (String(l.line_status || '').trim().toLowerCase() === 'cancelled') continue;
    var cid = sadCanonicalLineId_(isK2, draftId, l);
    if (byId[cid] === undefined) { byId[cid] = i; continue; }
    conflicts.push({
      canonical_line_id: cid,
      first_index: byId[cid], duplicate_index: i,
      sku: String(l.sku == null ? '' : l.sku), site_sku: String(l.site_sku == null ? '' : l.site_sku),
      window_code: String(l.window_code == null ? '' : l.window_code),
      first_planned_qty: String((lines[byId[cid]] || {}).planned_qty == null ? '' : lines[byId[cid]].planned_qty),
      duplicate_planned_qty: String(l.planned_qty == null ? '' : l.planned_qty)
    });
  }
  return { ok: conflicts.length === 0, conflicts: conflicts };
}

// FB-4D §B2 — PRE-WRITE duplicate-PK scan over the AFFECTED SCOPE. Read-only.
//
// WHY THIS IS A PRE-FLIGHT AND NOT A POST-CHECK. sadVerifyDraftLines_ already reports DUPLICATE_PRIMARY_KEY,
// but it runs AFTER the write: on the live three-row corruption a save would update the first matching row,
// leave the other two in place, and answer LINE_OUTPUT_VERIFICATION_FAILED — which the client can only class
// as `indeterminate`. So the operator was told "outcome unknown" about a table whose problem was already
// knowable before a single cell changed. §B2 requires the batch to be refused instead, with nothing written.
//
// SCOPE. Every physical row is read once and counted by primary key. A duplicate blocks when it is under THIS
// header (the affected scope), or when it names a canonical id this batch is about to resolve or insert —
// which is the "globally unique and present exactly once" half of §B1. `wantIds` may be empty, in which case
// only the in-scope check applies.
function sadScanDuplicateLinePks_(sh, draftId, wantIds) {
  var data = sh.getDataRange().getValues();
  var out = { ok: true, duplicates: [], physical_rows_scanned: Math.max(0, data.length - 1) };
  if (data.length < 2) return out;
  var hdr = data[0].map(function (x) { return String(x).trim(); });
  var pi = hdr.indexOf('allocation_draft_line_id'), di = hdr.indexOf('allocation_draft_id');
  if (pi === -1) return out;   // no PK column — the schema gate owns that failure, not this scan
  var want = {};
  (wantIds || []).forEach(function (x) { var k = String(x == null ? '' : x).trim(); if (k) want[k] = 1; });
  var seen = {};
  for (var r = 1; r < data.length; r++) {
    var pk = String(data[r][pi] == null ? '' : data[r][pi]).trim();
    if (!pk) continue;
    var dref = di === -1 ? '' : String(data[r][di] == null ? '' : data[r][di]).trim();
    if (!seen[pk]) seen[pk] = { pk: pk, rows: [], draft_ids: {} };
    seen[pk].rows.push(r + 1);
    seen[pk].draft_ids[dref] = 1;
  }
  Object.keys(seen).forEach(function (pk) {
    var g = seen[pk];
    if (g.rows.length < 2) return;
    var drafts = Object.keys(g.draft_ids);
    var inScope = drafts.indexOf(String(draftId).trim()) !== -1;
    if (!inScope && !want[pk]) return;   // a duplicate elsewhere that this batch does not touch
    out.ok = false;
    out.duplicates.push({ allocation_draft_line_id: pk, physical_rows: g.rows.length, sheet_rows: g.rows,
      allocation_draft_ids: drafts, in_affected_scope: inScope, targeted_by_this_batch: !!want[pk],
      spans_more_than_one_header: drafts.length > 1 });
  });
  return out;
}

// PURE read-after-write verification (§B.7). Given the rows actually stored for one draft and the lines the
// caller intended, prove: every expected line exists EXACTLY ONCE, at the exact quantity, with no primary key
// appearing twice, and with no unauthorized line under the draft. A count is not proof; this matches by identity.
function sadVerifyDraftLines_(draftId, expectedLines, storedRows, isK2) {
  function S(v) { return String(v == null ? '' : v).trim(); }
  function L(v) { return S(v).toLowerCase(); }
  function N(v) { var n = Number(S(v)); return isFinite(n) ? n : NaN; }
  var out = { ok: false, failures: [], expected_line_count: 0, verified_line_count: 0, stored_line_count: 0, duplicate_primary_keys: [] };

  var mine = (storedRows || []).filter(function (r) { return S(r && r.allocation_draft_id) === S(draftId); });
  out.stored_line_count = mine.length;

  // PK uniqueness across the whole draft — the exact defect this task exists to close.
  var pkCount = {};
  mine.forEach(function (r) { var k = S(r.allocation_draft_line_id); if (!k) return; pkCount[k] = (pkCount[k] || 0) + 1; });
  Object.keys(pkCount).forEach(function (k) {
    if (pkCount[k] > 1) {
      out.duplicate_primary_keys.push({ allocation_draft_line_id: k, physical_rows: pkCount[k] });
      out.failures.push({ code: 'DUPLICATE_PRIMARY_KEY', allocation_draft_line_id: k, physical_rows: pkCount[k] });
    }
  });

  var active = mine.filter(function (r) { return !SAD_TERMINAL_LINE_STATUSES_[L(r.line_status)] || L(r.line_status) === 'submitted'; });
  var expected = (expectedLines || []).filter(function (l) { return L(l.line_status) !== 'cancelled'; });
  out.expected_line_count = expected.length;

  var claimed = {};
  expected.forEach(function (l) {
    var cid = sadCanonicalLineId_(isK2, draftId, l);
    var hits = active.filter(function (r) { return S(r.allocation_draft_line_id) === cid; });
    if (hits.length === 0) {
      // fall back to identity matching, so a legacy row with a different stored id is reported as MISSING_ID
      var byIdentity = active.filter(function (r) { return sadSameLineIdentity_(r, l); });
      if (byIdentity.length === 0) { out.failures.push({ code: 'LINE_MISSING', canonical_line_id: cid, sku: S(l.sku) }); return; }
      if (byIdentity.length > 1) { out.failures.push({ code: 'LINE_DUPLICATED', canonical_line_id: cid, sku: S(l.sku), physical_rows: byIdentity.length }); return; }
      hits = byIdentity;
    } else if (hits.length > 1) {
      out.failures.push({ code: 'LINE_DUPLICATED', canonical_line_id: cid, sku: S(l.sku), physical_rows: hits.length });
      return;
    }
    var row = hits[0];
    claimed[S(row.allocation_draft_line_id) + '#' + S(row.sku) + '#' + S(row.site_sku) + '#' + S(row.window_code)] = 1;
    var want = N(l.planned_qty), got = N(row.planned_qty);
    if (l.planned_qty != null && String(l.planned_qty) !== '' && want !== got) {
      out.failures.push({ code: 'LINE_QUANTITY_MISMATCH', canonical_line_id: cid, sku: S(l.sku), expected: want, found: got });
      return;
    }
    if (!S(row.allocation_draft_line_id)) { out.failures.push({ code: 'LINE_ID_MISSING', sku: S(l.sku) }); return; }
    out.verified_line_count++;
  });

  // No line under this draft that the caller did not authorise. This is how "no unauthorized line" is PROVEN
  // rather than assumed — a count check could never see it.
  active.forEach(function (r) {
    var k = S(r.allocation_draft_line_id) + '#' + S(r.sku) + '#' + S(r.site_sku) + '#' + S(r.window_code);
    if (!claimed[k]) out.failures.push({ code: 'UNEXPECTED_LINE', allocation_draft_line_id: S(r.allocation_draft_line_id), sku: S(r.sku) });
  });

  out.ok = out.failures.length === 0;
  return out;
}

function sadUpsertLinesKeyedCore_(body) {
  var draftId = String((body && body.allocation_draft_id) || '').trim();
  if (!draftId) return jsonResponse_({ success: false, error: 'allocation_draft_id required' });
  var rawLines = (body && body.lines) || [];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = procurementEnsureSheet_(ss, 'shipping_allocation_draft_lines', SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_);
  var now = procurementTimestamp_();
  var created = 0, updated = 0, skipped = 0;

  // Alias-map every line up front, then validate the whole batch BEFORE any write so an incomplete
  // manual line rejects the request with ZERO mutation (System Repair 2 §4/§8; C2-D1R). A soft-cancel line
  // (line_status='cancelled') and a system-generated recommendation snapshot are exempt; only a manual
  // execution line must carry SKU + Qty>0 (route context is HEADER-level in the 28-col line grain).
  // R6F2G (B): the resolved draft id itself is the K2 group authority for this keyed path (a real stored SADH-K2- id,
  // not a caller classification) — a K2 draft heals/mints K2 line ids so no keyed write reintroduces a SADL- line
  // under a K2 header; a generic/legacy draft is unchanged.
  var isK2Draft = (String(draftId).indexOf('SADH-K2-') === 0);
  var lines = [];
  for (var m = 0; m < rawLines.length; m++) lines.push(sadApplyLineAliases_(rawLines[m] || {}));
  for (var v = 0; v < lines.length; v++) {
    var lv = lines[v];
    var isCancelV = String(lv.line_status || '').trim().toLowerCase() === 'cancelled';
    var isSystemV = String(lv.generation_type || '').trim().toLowerCase() === 'system_generated';
    if (isCancelV || isSystemV) continue;
    if (!sadLineIsComplete_(lv)) return jsonResponse_({ success: false, error: 'PLAN_LINE_INCOMPLETE — a manual Execution Plan line requires SKU + Qty>0 (zero rows written); route context is on the Draft header' });
  }

  // FB-4B §B — batch pre-flight, BEFORE any write, so a rejection is a proven zero-write.
  var pre = sadPreflightLineBatch_(isK2Draft, draftId, lines);
  if (!pre.ok) {
    return jsonResponse_({ success: false, error: 'DUPLICATE_LINE_IDENTITY_IN_BATCH — two incoming lines resolve to the SAME canonical line identity under this Draft header. Under the frozen K2 contract a Header holds ONE line per (sku, site_sku, window_code) because route and source are HEADER dimensions, so two routes for one SKU either ARE the same line (same route group) or belong under DIFFERENT headers (different route group). Persisting both would destroy one of the quantities. Zero rows written.',
      stage: 'lines', zero_write: true,
      data: { status: 'DUPLICATE_LINE_IDENTITY_IN_BATCH', allocation_draft_id: draftId, conflicts: pre.conflicts } });
  }

  // FB-4D §B2 — THE LAST GATE BEFORE THE FIRST WRITE. A physical primary key that already names more than one
  // row in the affected scope makes every subsequent resolution ambiguous: procurementFindRow_ returns the FIRST
  // match, so an update would silently pick one of the duplicates and leave the rest countable. Refuse with a
  // proven zero write and name the exact sheet rows, so the operator repairs the table rather than guessing.
  var dupScan = sadScanDuplicateLinePks_(sh, draftId, lines.map(function (x) { return sadCanonicalLineId_(isK2Draft, draftId, x); }));
  if (!dupScan.ok) {
    return jsonResponse_({ success: false, error: 'EXISTING_DUPLICATE_PRIMARY_KEY_IN_SCOPE — the database already holds more than one physical row under one allocation_draft_line_id in the scope this write would touch. While that is true every insert/update decision here is ambiguous, so NOTHING was written. Remove the duplicate physical rows first (the read-only duplicate diagnostic names the survivor and the rows to delete), then save again.',
      stage: 'lines', zero_write: true,
      data: { status: 'EXISTING_DUPLICATE_PRIMARY_KEY_IN_SCOPE', allocation_draft_id: draftId,
        physical_rows_scanned: dupScan.physical_rows_scanned, duplicates: dupScan.duplicates,
        next_action: 'Run the read-only duplicate diagnostic for this header, remove the surplus physical rows, then re-save. This refusal wrote nothing.' } });
  }

  var EXEC_FIELDS = ['planned_qty', 'override_reason', 'line_status', 'route_no', 'units_per_carton', 'note', 'expected_arrival'];

  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var lineId = String(l.allocation_draft_line_id || '').trim();
    // R6F: explicit id match when present; otherwise reconcile a GENERATED line (blank id, keyed by natural key by the
    // KMPR generate path) BY NATURAL KEY so an edit updates that exact row instead of appending a duplicate.
    // FB-4B §B — CANONICAL identity resolution. The caller's id is a HINT, never the identity.
    var canonicalId = sadCanonicalLineId_(isK2Draft, draftId, l);
    var found = null, resolvedBy = '';
    if (lineId) {
      var byExplicit = procurementFindRow_(sh, 'allocation_draft_line_id', lineId);
      if (byExplicit) {
        // An explicit id that names a row describing a DIFFERENT logical line is an attempt to rename an
        // identity. Fail closed rather than silently rewrite someone else's row.
        var explicitRow = sadRowToObject_(sh, byExplicit.row);
        if (!sadSameLineIdentity_(explicitRow, l)) {
          return jsonResponse_({ success: false, error: 'LINE_IDENTITY_CONFLICT — the supplied allocation_draft_line_id names a stored row whose (sku, site_sku, window_code) differs from the incoming line, so honouring it would overwrite a different line. Zero rows written.',
            stage: 'lines', zero_write: true,
            data: { status: 'LINE_IDENTITY_CONFLICT', allocation_draft_id: draftId, supplied_line_id: lineId,
              stored: { sku: String(explicitRow.sku || ''), site_sku: String(explicitRow.site_sku || ''), window_code: String(explicitRow.window_code || '') },
              incoming: { sku: String(l.sku || ''), site_sku: String(l.site_sku || ''), window_code: String(l.window_code || '') } } });
        }
        found = byExplicit; resolvedBy = 'EXPLICIT_ID';
      }
    }
    // THE FIX FOR THE LIVE DUPLICATE: before considering an INSERT, look the CANONICAL id up. A stale client-side
    // id that no longer resolves used to fall straight through to append; now it converges on the existing row.
    if (!found) {
      var byCanonical = procurementFindRow_(sh, 'allocation_draft_line_id', canonicalId);
      if (byCanonical) { found = byCanonical; resolvedBy = 'CANONICAL_ID'; }
    }
    if (!found) {
      var byNatural = sadFindLineByNaturalKey_(sh, draftId, l);
      if (byNatural) { found = byNatural; resolvedBy = 'NATURAL_KEY'; }
    }
    // Defensive: a soft-cancel for a line that was never stored (e.g. an incomplete route the user
    // cleared before it was ever persisted) must NOT append a spurious cancelled row — skip it.
    if (!found && String(l.line_status || '').trim().toLowerCase() === 'cancelled') { skipped++; continue; }
    if (found) {
      // Round 1H: NEVER mutate a line-terminal row (submitted/cancelled/superseded) — skip it.
      var cLS = found.col('line_status');
      var curLS = cLS !== -1 ? String(sh.getRange(found.row, cLS + 1).getValue()).trim().toLowerCase() : '';
      if (SAD_TERMINAL_LINE_STATUSES_[curLS]) { skipped++; continue; }   // FB-4C: `expired` is terminal too
      // R6F: heal a blank generated-line id with the deterministic SADL id so future edits/readback carry a stable id
      // (idempotent — a nonblank id is never overwritten).
      var cId0 = found.col('allocation_draft_line_id');
      if (cId0 !== -1) { var curId0 = String(sh.getRange(found.row, cId0 + 1).getValue()).trim(); if (!curId0) sh.getRange(found.row, cId0 + 1).setValue(sadNewLineId_(isK2Draft, draftId, l)); }
      function setU(name) { if (l[name] != null) { var c = found.col(name); if (c !== -1) sh.getRange(found.row, c + 1).setValue(String(l[name])); } }
      // Execution-Plan (user) fields — always update when provided.
      EXEC_FIELDS.forEach(setU);
      // Recommendation snapshot — update ONLY when explicitly provided (preserve otherwise).
      SAD_RECOMMENDATION_FIELDS_.forEach(function (f) { if (l[f] != null && l[f] !== '') setU(f); });
      var uc = found.col('updated_at'); if (uc !== -1) sh.getRange(found.row, uc + 1).setValue(now);
      updated++;
    } else {
      // R6F: DETERMINISTIC id (frozen formula) so regeneration/edit of the same logical line reuses the same id
      // (no random-UUID drift, no duplicate on retry). Explicit ids from the frontend are honored as-is for a generic
      // draft; a K2 draft (R6F2G) ALWAYS mints the canonical K2 line id (never trusts an arbitrary caller id).
      lineId = canonicalId;
      // Defence in depth: nothing may ever append onto an id that already exists. The three duplicate live rows
      // are exactly what the absence of this assertion produced.
      if (procurementFindRow_(sh, 'allocation_draft_line_id', lineId)) {
        return jsonResponse_({ success: false, error: 'LINE_PRIMARY_KEY_ALREADY_EXISTS — refusing to append a second physical row under an existing allocation_draft_line_id. Nothing further was written.',
          stage: 'lines', data: { status: 'LINE_PRIMARY_KEY_ALREADY_EXISTS', allocation_draft_id: draftId, allocation_draft_line_id: lineId, lines_committed: created + updated } });
      }
      var recQty = (l.recommended_qty != null && l.recommended_qty !== '') ? procurementNum_(l.recommended_qty) : '';
      var planned = (l.planned_qty != null && l.planned_qty !== '') ? procurementNum_(l.planned_qty)
        : (recQty !== '' ? recQty : '');   // first creation: planned_qty = recommended_qty
      var rowObj = { allocation_draft_line_id: lineId, allocation_draft_id: draftId, created_at: now, updated_at: now,
        planned_qty: planned, recommended_qty: recQty };
      // Copy all remaining provided canonical fields (skip forbidden display fields).
      // B3 - the FULL authority, so expected_arrival is carried when the column exists. Iterating the REQUIRED
      // 30 would have skipped it forever, which is the silent drop this round exists to end.
      SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_.forEach(function (h) {
        if (h in rowObj) return;
        if (l[h] != null) rowObj[h] = String(l[h]);
      });
      procurementAppendByHeader_(sh, rowObj);
      created++;
    }
  }
  // FB-4B §B.7 — EXACT READ-AFTER-WRITE VERIFICATION. A writer reporting created/updated counts is not proof:
  // the live corruption produced a perfectly happy "created: 1" three times over. Re-read the draft's lines and
  // check identity, exact quantity, PK uniqueness and the absence of any unauthorised line.
  var storedRows = sadReadLinesForDraft_(sh, draftId);
  var verify = sadVerifyDraftLines_(draftId, lines, storedRows, isK2Draft);
  // FB-4B §B — the response now carries the ids ACTUALLY PERSISTED, so the caller can adopt them and stop
  // sending an id the server never stored. That closed loop is what made every save append another row.
  // FB-4D §B3 — the ROUTE GROUP KEY travels with the ids. A client holding two route groups for one SKU could
  // previously only tell which header a returned line belonged to by trusting the request it had just sent; under
  // a partial failure that is exactly the assumption that hands Route A's id to Route B. The group key is read
  // from the STORED header, never recomputed from the request, so it is evidence rather than an echo.
  var hdrSh = ss.getSheetByName('shipping_allocation_drafts');
  var hdrRow = hdrSh ? procurementFindRow_(hdrSh, 'allocation_draft_id', draftId) : null;
  var hdrObj = hdrRow ? sadRowToObject_(hdrSh, hdrRow.row) : null;
  var routeGroupKey = hdrObj ? sadK2GroupKey_(hdrObj) : '';
  var persistedHeaders = hdrObj ? [{
    allocation_draft_id: draftId, route_group_key: routeGroupKey,
    status: String(hdrObj.status || ''),
    deterministic_group_id: sadK2DeterministicHeaderId_(hdrObj),
    group_id_matches_stored_id: sadK2DeterministicHeaderId_(hdrObj) === String(draftId).trim(),
    planning_cycle: String(hdrObj.planning_cycle || ''), company: String(hdrObj.company || ''),
    country: String(hdrObj.country || ''), marketplace: String(hdrObj.marketplace || ''),
    recommended_source_warehouse_id: String(hdrObj.recommended_source_warehouse_id || ''),
    recommended_destination_warehouse_id: String(hdrObj.recommended_destination_warehouse_id || ''),
    recommended_shipping_method: String(hdrObj.recommended_shipping_method || '')
  }] : [];
  var persisted = storedRows.map(function (r) {
    return { allocation_draft_line_id: String(r.allocation_draft_line_id || ''),
      allocation_draft_id: String(r.allocation_draft_id || draftId),
      route_group_key: routeGroupKey,
      sku: String(r.sku || ''),
      site_sku: String(r.site_sku || ''), window_code: String(r.window_code || ''),
      planned_qty: String(r.planned_qty == null ? '' : r.planned_qty), line_status: String(r.line_status || '') };
  });
  if (!verify.ok) {
    return jsonResponse_({ success: false, error: 'LINE_OUTPUT_VERIFICATION_FAILED — the write was applied but the re-read does not match what was asked for. Nothing was rolled back; inspect the rows below before retrying.',
      stage: 'verify',
      data: { status: 'LINE_OUTPUT_VERIFICATION_FAILED', allocation_draft_id: draftId, verification: verify,
        created: created, updated: updated, skipped: skipped,
        persisted_headers: persistedHeaders, persisted_lines: persisted } });
  }
  return jsonResponse_({ success: true, data: { allocation_draft_id: draftId, line_count: created + updated,
    created: created, updated: updated, skipped: skipped,
    verification: verify, persisted_headers: persistedHeaders, persisted_lines: persisted } });
}

// C2-D1R line completeness (§8) — route context is HEADER-level, so a manual Execution Plan LINE is valid
// with SKU + Qty>0. From/To/Method completeness is enforced on the header via sadHeaderRouteIsComplete_.
function sadLineIsComplete_(l) {
  l = l || {};
  var sku = String(l.sku == null ? '' : l.sku).trim();
  var qty = Number(l.planned_qty); if (isNaN(qty)) qty = 0;
  return !!sku && qty > 0;
}
// ================================================================================================================
// F1-7N-FB-4G-A0-R2 — ONE DESTINATION AUTHORITY FOR EVERY 16_ PATH.
// ================================================================================================================
// 69_ ricDestinationIdentity_ has been the canonical rule since B3: WAREHOUSE xor MARKETPLACE, BOTH is
// ROUTE_DESTINATION_AMBIGUOUS, NEITHER is ROUTE_DESTINATION_MISSING, and no snapshot, label, scope or filter
// participates. The K4 resolver used it. The three gates below did NOT, and each disagreed with it differently:
//
//   BOTH        ricDestinationIdentity_ AMBIGUOUS  ·  sadHeaderRouteIsComplete_ TRUE  — `toReal || marketplace`
//               short-circuits, so a row carrying two contradictory destinations passed the write gate on BOTH
//               writers and passed Submit. Measured, not inferred.
//   snapshot    ricDestinationIdentity_ MISSING    ·  sadStoredHeaderRouteIsComplete_ TRUE — the FB-4D fallback
//   only        below read recommended_destination_warehouse_code_snapshot as the destination, so the LIVE H4
//               header (warehouse id blank, marketplace blank, snapshot 'Amazon') was Submit-complete on the
//               strength of a marketplace name sitting in a warehouse-code column.
//
// This is that one function, and every gate now goes through it. It delegates to the 69_ contract when that
// file is deployed and applies the IDENTICAL rule inline when it is not — a fallback that must never disagree,
// which the regression suite proves across all four states rather than asserting in a comment.
function sadDestinationIdentity_(h) {
  if (typeof ricDestinationIdentity_ === 'function') return ricDestinationIdentity_(h);
  h = h || {};
  function s(v) { return String(v == null ? '' : v).trim(); }
  var wid = s(h.recommended_destination_warehouse_id) || s(h.destination_warehouse_id);
  var mkt = s(h.destination_marketplace);
  if (wid && mkt) return { type: '', id: '', ok: false, code: 'ROUTE_DESTINATION_AMBIGUOUS' };
  if (wid) return { type: 'WAREHOUSE', id: wid, ok: true, code: '' };
  if (mkt) return { type: 'MARKETPLACE', id: mkt.toLowerCase(), ok: true, code: '' };
  return { type: '', id: '', ok: false, code: 'ROUTE_DESTINATION_MISSING' };
}

// Header route completeness (§8, C2-D1R): From + exactly ONE canonical destination + Method on the Draft
// header (recommended_*). A marketplace destination is a valid To; a marketplace AND a warehouse is not a
// destination at all.
//
// F1-7N-FB-4D §B5 — ROUTE COMPLETENESS OF A **STORED** HEADER ROW, and why the two are ONE function now.
//
// FB-4D found that the write gate (which saw the request body) called an Amazon route complete while the Submit
// gate (which saw the stored row) called it INCOMPLETE, and refused a whole station after both routes had
// persisted correctly. Its diagnosis rested on a premise that was true then: destination_marketplace was "an
// accepted PAYLOAD field and NOT a stored column", so the stored row's only retained evidence was the code
// snapshot. B4 made the column stored; A0-R1 made the two-call writer actually persist it. The premise is gone,
// and with it the reason for a second predicate: the STORED row now carries the destination itself.
//
// The snapshot fallback is REMOVED, and that is a deliberate behaviour change with a known consequence. A row
// saved BEFORE A0-R1 has a blank destination_marketplace and a marketplace name in its code snapshot; such a row
// is now correctly ROUTE_DESTINATION_MISSING and Submit refuses it. The remedy is the explicit, user-confirmed
// adoption A0-R1 built — not a gate that reads a display snapshot as a business identity.
function sadStoredHeaderRouteIsComplete_(h) { return sadHeaderRouteIsComplete_(h); }

function sadHeaderRouteIsComplete_(b) {
  b = b || {};
  var from = String(b.recommended_source_warehouse_id == null ? '' : b.recommended_source_warehouse_id).trim();
  // EXACTLY ONE canonical destination. Never `a || b`: that is what let BOTH through.
  var hasTo = sadDestinationIdentity_(b).ok;
  var method = String(b.recommended_shipping_method == null ? '' : b.recommended_shipping_method).trim();
  // The service rule is UNCHANGED this round, deliberately. Tightening it to ricCanonicalService_ would make
  // every stored route whose method spelling 69_'s table does not carry un-submittable, which is a live-impact
  // decision this round was not asked to take and has no evidence to take. Recorded rather than skipped.
  var methodOk = !!method && method.toLowerCase().indexOf('no available') === -1;
  return !!from && hasTo && methodOk;
}

// ================================================================================================================
// F1-7N-FA-3C-R6F1 — ATOMIC Header + Lines write (Section C). ONE controlled ScriptLock; validate EVERYTHING before
// the first write; Header + all Lines committed together from the caller's perspective.
//   Body: { header:{...}, lines:[...], expected_draft_version?, enforce_k2_grouping? }
// PRE-WRITE (any failure => ZERO mutation, zero_write:true): both sheet schemas EXACT (30 header / 30 line,
//   order-sensitive — rule 9, no order-agnostic tolerance) · header route-completeness when route intent present ·
//   every manual line complete (SKU + Qty>0) · no duplicate line identity within the batch · FK grouping (all lines
//   belong to this ONE header) · OPTIONAL K2 incompatible-route guard (enforce_k2_grouping:true — the frozen K2
//   contract; OFF by default while live K2 activation is HALTed).
// NEW draft: append Header, then all Lines. If a line write THROWS after a NEW Header was created, COMPENSATE by
//   soft-cancelling (NEVER hard-delete) that exact Header and return COMMITTED_UNVERIFIED + reconciliation evidence —
//   never a generic clean failure.
// EXISTING draft: never delete existing data; a line-write failure fails closed with RECONCILIATION_REQUIRED evidence.
function handleUpsertShippingAllocationDraftAtomic_(body) {
  var lock = LockService.getScriptLock();
  try { if (!lock.tryLock(30000)) return jsonResponse_({ success: false, error: 'Could not acquire lock; please retry.', stage: 'lock' }); }
  catch (e) { return jsonResponse_({ success: false, error: 'Lock error: ' + (e && e.message ? e.message : e), stage: 'lock' }); }
  try { return sadAtomicUpsertCore_(body); }
  finally { try { lock.releaseLock(); } catch (e2) { /* best-effort release */ } }
}

// EXACT (order-sensitive) header-row check against a canonical authority. '' when OK, else a reason string. Trailing
// all-blank cells are not real columns. Pure over a sheet-like object exposing getDataRange().getValues().
// ADDENDUM §D — EXACT, with ONE documented optional tail. `optionalTail` names a trailing suffix of `authority`
// that a live sheet is permitted not to have yet (the pre-migration state). Everything else is unchanged and
// still exact: the live header must be a BYTE-EXACT PREFIX of the authority, so a reorder, a rename, a blank, a
// duplicate or ANY unknown extra column still fails closed with the same deterministic reason string. This is a
// CLOSED allowance over four named columns - not the order-agnostic tolerance rule 9 forbids.
// F1-7N-FB-4F-B3 - the LIVE header names of a sheet, trimmed, trailing blanks dropped. Read-only; this is the
// only thing the compatibility layer needs to know about a sheet's shape, and it never writes to discover it.
function sadLiveHeaderNames_(sh) {
  var data = sh.getDataRange().getValues();
  var a = (data && data.length ? data[0] : []).map(function (h) { return String(h == null ? '' : h).trim(); });
  while (a.length && a[a.length - 1] === '') a.pop();
  return a;
}
function sadHasColumn_(names, col) { return (names || []).indexOf(col) !== -1; }

// K4 IS ACTIVATED BY THE SCHEMA, NEVER BY A FLAG. A deterministic identity that cannot be persisted is not an
// identity - it is a number that disappears on write - so K4 is used only when the column that carries its
// destination dimension PHYSICALLY EXISTS, and only when the frozen contract that computes it is actually
// loaded. Before that, the resolver behaves exactly as it did, byte for byte.
// F1-7N-FB-4G-A2-R3 §F — CAN THIS DEPLOYMENT REMEMBER A CREATE KEY AT ALL?
//
// If the column is absent there is no safe CREATE: the request would be accepted and a retry would mint a
// second ticket, which is precisely the failure this round closes. So a create REFUSES rather than degrading
// to an unprotected one. A READ of an older row is unaffected — pre-migration rows simply have no key.
function sadCreateIdempotencyReady_(headerNames) {
  return sadHasColumn_(headerNames, 'create_idempotency_key');
}

// The header an earlier attempt of THIS SAME create key already wrote, or null. Scoped by key alone: the key
// is minted per + Add Route click and is globally unique, so it names one attempt and not one route shape.
// A BLANK stored key never matches anything — a pre-migration row is not a replay of a click that had no key.
function sadFindHeaderByCreateKey_(sh, createKey) {
  var want = String(createKey == null ? '' : createKey).trim();
  if (!want) return null;
  var data = sh.getDataRange().getValues();
  if (!data || data.length < 2) return null;
  var names = data[0].map(function (x) { return String(x).trim(); });
  var cKey = names.indexOf('create_idempotency_key');
  var cId = names.indexOf('allocation_draft_id');
  if (cKey === -1 || cId === -1) return null;
  for (var r = 1; r < data.length; r++) {
    var got = String(data[r][cKey] == null ? '' : data[r][cKey]).trim();
    if (!got) continue;                       // blank is never a match (never a replay)
    if (got === want) return { row: r + 1, allocation_draft_id: String(data[r][cId] == null ? '' : data[r][cId]).trim() };
  }
  return null;
}

// §B.2 — THE IDENTITY FOR A NEW TICKET. The deterministic K2 id is used when it is free, because it keeps the
// canonical shape readers already understand. When it is TAKEN — which is exactly the identical-route second
// Add Route case §B.2 legitimises — a fresh non-deterministic id is minted instead. It is NEVER a refusal, and
// it is never a reuse of the row that holds the deterministic id.
function sadMintNewHeaderId_(sh, header, k4Ready) {
  // The deterministic id comes from the SAME authority the resolver would have used: K4 when the schema can
  // store a canonical destination, K2 otherwise. Minting a K2 id on a K4-ready sheet would give a brand-new
  // route the older identity family and make every reader disagree about which key it belongs to.
  var det = '';
  if (k4Ready === true && typeof ricK4DeterministicHeaderId_ === 'function') {
    try { det = ricK4DeterministicHeaderId_(header); } catch (e4) { det = ''; }
  }
  if (!det) {
    try { det = sadK2DeterministicHeaderId_(header); } catch (e) { det = ''; }
  }
  if (det && !procurementFindRow_(sh, 'allocation_draft_id', det)) return det;
  for (var attempt = 0; attempt < 8; attempt++) {
    var cand = 'SAD-' + Utilities.getUuid().substring(0, 10).toUpperCase();
    if (!procurementFindRow_(sh, 'allocation_draft_id', cand)) return cand;
  }
  return '';
}

function sadK4SchemaReady_(headerNames) {
  return sadHasColumn_(headerNames, 'destination_marketplace') &&
    typeof ricK4GroupKey_ === 'function' && typeof ricK4DeterministicHeaderId_ === 'function' &&
    typeof ricDestinationIdentity_ === 'function';
}

// NOTHING SUPPLIED IS EVER SILENTLY DROPPED. This is the rule the live sheet was broken by: the request said
// Amazon and sea_express, the write SUCCEEDED, and the truth did not survive it - because the writer copies by
// header NAME and a name with no column is simply skipped. A value that cannot be persisted must make the
// request FAIL, with the typed reason, and write nothing.
//
// The rules themselves live in 69_api_v1_route_identity_contract.gs and are called, not copied - a second
// implementation of an identity rule is a second answer waiting to disagree. When a supplied value needs that
// contract and the contract is not loaded, this refuses rather than guessing; when nothing new is supplied it
// never consults it at all, so a deployment that has 16_ but not yet 69_ behaves exactly as it does today.
function sadSchemaRefusal_(header, lines, headerNames, lineNames) {
  header = header || {};
  function s(v) { return String(v == null ? '' : v).trim(); }
  var wantsMarketplace = s(header.destination_marketplace) !== '';
  var etaLines = 0;
  (lines || []).forEach(function (l) { if (l && s(l.expected_arrival) !== '') etaLines++; });
  var wantsService = s(header.recommended_shipping_method) !== '' || s(header.shipping_method) !== '';
  var bothDest = s(header.recommended_destination_warehouse_id) !== '' && wantsMarketplace;

  // The ETA is LINE-owned, so it is checked against the LINE schema. 69_'s predicate covers the header side.
  if (etaLines && !sadHasColumn_(lineNames, 'expected_arrival')) {
    return { error: 'EXPECTED_ARRIVAL_NOT_PERSISTABLE', schema_code: 'ALLOCATION_DRAFT_SCHEMA_COLUMN_ABSENT',
      column: 'expected_arrival', table: 'shipping_allocation_draft_lines', lines_supplying_it: etaLines };
  }
  if (!wantsMarketplace && !bothDest && !wantsService) return null;
  if (typeof ricRoutePersistability_ !== 'function') {
    // Only reachable when a request actually needs the contract and the contract is absent.
    if (wantsMarketplace || bothDest) {
      return { error: 'ROUTE_IDENTITY_NOT_PERSISTABLE', schema_code: 'ROUTE_IDENTITY_CONTRACT_NOT_LOADED',
        column: 'destination_marketplace', table: 'shipping_allocation_drafts' };
    }
    return null;
  }
  var v = ricRoutePersistability_(header, headerNames, lineNames);
  if (v && v.persistable === false && v.refusals && v.refusals.length) {
    var first = v.refusals[0];
    return { error: first.code, schema_code: first.schema_code, column: first.column, table: first.table,
      supplied: first.supplied, refusals: v.refusals };
  }
  return null;
}

// CREATE / REUSE / CONFLICT over the K4 group key among ACTIVE headers. The shape mirrors
// sadK2ResolveActiveDraft_ deliberately, with two differences that matter:
//
//   1. Only rows whose OWN destination resolves are candidates. A legacy row that stores neither a destination
//      warehouse nor a marketplace has no K4 identity to compare, so it is not a match - and it is not quietly
//      treated as one either.
//   2. REUSE returns the row's STORED id, whatever generation minted it. An existing SADH-K2- row that happens
//      to key to this K4 group is adopted UNDER ITS OWN ID - never re-keyed, never duplicated. Re-keying would
//      orphan every line row pointing at it.
function sadK4ResolveActiveDraft_(rows, wantHeader) {
  var ACTIVE = { draft: 1, site_confirmed: 1, partially_submitted: 1 };
  var want = ricK4GroupKey_(wantHeader), matches = [];
  (rows || []).forEach(function (r) {
    if (!ACTIVE[String(r && r.status == null ? '' : r.status).trim().toLowerCase()]) return;
    if (!ricDestinationIdentity_(r).ok) return;         // no resolvable destination = no K4 identity to compare
    if (ricK4GroupKey_(r) === want) matches.push(String(r.allocation_draft_id == null ? '' : r.allocation_draft_id).trim());
  });
  if (matches.length === 0) return { status: 'CREATE', k4Key: want, allocation_draft_id: ricK4DeterministicHeaderId_(wantHeader) };
  if (matches.length === 1) return { status: 'REUSE', k4Key: want, allocation_draft_id: matches[0] };
  return { status: 'BLOCKED_CONFLICT', k4Key: want, conflictIds: matches };
}

function sadExactSchemaReason_(sh, authority, optionalTail) {
  var data = sh.getDataRange().getValues();
  var actual = (data && data.length ? data[0] : []).map(function (h) { return String(h == null ? '' : h).trim(); });
  while (actual.length && actual[actual.length - 1] === '') actual.pop();
  var tail = optionalTail || [];
  var minLen = authority.length - tail.length;
  if (actual.length < minLen || actual.length > authority.length) {
    return 'COL_COUNT_' + actual.length + '_EXPECTED_' + (tail.length ? minLen + '_TO_' + authority.length : String(authority.length));
  }
  for (var i = 0; i < actual.length; i++) if (actual[i] !== authority[i]) return 'COL' + i + '_IS_' + (actual[i] || '(blank)') + '_EXPECTED_' + authority[i];
  return '';
}

// Which lifecycle tail columns the LIVE sheet actually has, in canonical order, plus the exact ones missing.
// This is the single source of truth for "is the lifecycle schema present?" - the activation gate and the
// migration tool both read it rather than each forming their own opinion.
function sadLifecycleTailState_(sh) {
  var data = sh.getDataRange().getValues();
  var actual = (data && data.length ? data[0] : []).map(function (h) { return String(h == null ? '' : h).trim(); });
  while (actual.length && actual[actual.length - 1] === '') actual.pop();
  var base = SHIPPING_ALLOCATION_DRAFTS_HEADERS_.length, present = [], missing = [], misplaced = [];
  SAD_LIFECYCLE_TAIL_COLUMNS_.forEach(function (c, i) {
    var at = actual.indexOf(c);
    if (at === -1) { missing.push(c); return; }
    present.push(c);
    if (at !== base + i) misplaced.push({ column: c, expected_index: base + i, actual_index: at });
  });
  return {
    live_count: actual.length, live_headers: actual,
    canonical_count: SHIPPING_ALLOCATION_DRAFTS_HEADERS_CANONICAL_.length,
    present: present, missing: missing, misplaced: misplaced,
    complete: missing.length === 0 && misplaced.length === 0
  };
}

// Pure pre-write validation for the atomic path. Returns { ok:true, lines:[aliased] } or { ok:false, error, stage,
// data? }. No sheet access, no mutation. `existingHeaders` = { drafts:[...], lines:[...] } actual header rows (for the
// EXACT schema check); when omitted the schema check is skipped (caller validated it).
function sadAtomicValidateBatch_(header, rawLines, enforceK2) {
  header = header || {};
  var status = String(header.status || 'draft').trim(); if (!SAD_STATUSES_[status]) status = 'draft';
  // F1-7N-FB-4G-A0-R2 — the ATOMIC path carried the identical predicate with the identical omission. The two
  // writers must recognise route intent the same way or one of them accepts what the other refuses.
  var hasRouteIntent = !!(String(header.recommended_source_warehouse_id || '').trim() ||
    String(header.recommended_shipping_method || '').trim() || String(header.recommended_destination_warehouse_id || '').trim() ||
    String(header.destination_marketplace || '').trim());
  if (hasRouteIntent && status !== 'cancelled' && !sadHeaderRouteIsComplete_(header)) {
    return { ok: false, stage: 'header', error: 'PLAN_HEADER_INCOMPLETE — route requires From + To + Method (zero rows written)' };
  }
  var lines = [], seen = {};
  for (var i = 0; i < (rawLines || []).length; i++) {
    var l = sadApplyLineAliases_(rawLines[i] || {});
    var isCancel = String(l.line_status || '').trim().toLowerCase() === 'cancelled';
    var isSystem = String(l.generation_type || '').trim().toLowerCase() === 'system_generated';
    if (!isCancel && !isSystem && !sadLineIsComplete_(l)) return { ok: false, stage: 'lines', error: 'PLAN_LINE_INCOMPLETE — a manual line requires SKU + Qty>0 (zero rows written)' };
    var lineId = String(l.allocation_draft_line_id || '').trim();
    var nk = lineId || sadLineNaturalKey_('__ATOMIC__', l);
    if (seen[nk]) return { ok: false, stage: 'lines', error: 'DUPLICATE_LINE_IN_BATCH — two lines resolve to the same identity (zero rows written): ' + nk };
    seen[nk] = 1;
    lines.push(l);
  }
  if (enforceK2 === true) {
    var g = sadK2LinesRouteCompatibleWithHeader_(header, lines);
    if (!g.compatible) return { ok: false, stage: 'grouping', error: 'K2_ROUTE_INCOMPATIBLE — a line carries route values incompatible with the header shipment group (zero rows written)', data: { violations: g.violations } };
  }
  return { ok: true, lines: lines };
}

function sadAtomicUpsertCore_(body) {
  body = body || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var header = body.header || {};

  // ensure both sheets, then validate BOTH schemas EXACT (rule 9 — no order-agnostic tolerance).
  var hSh = procurementEnsureSheet_(ss, 'shipping_allocation_drafts', SHIPPING_ALLOCATION_DRAFTS_HEADERS_);
  var lSh = procurementEnsureSheet_(ss, 'shipping_allocation_draft_lines', SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_);
  // §5 — the SHARED authority, the same one the AI Plan lifecycle gate reads. Before this the two
  // asked different questions of the same header row and answered differently.
  var hR = sadDraftsSchemaReason_(hSh);
  if (hR) return jsonResponse_({ success: false, error: 'SCHEMA_MISMATCH [shipping_allocation_drafts] ' + hR, stage: 'schema', zero_write: true });
  var lR = sadExactSchemaReason_(lSh, SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_, SAD_LINE_ETA_TAIL_COLUMNS_);
  if (lR) return jsonResponse_({ success: false, error: 'SCHEMA_MISMATCH [shipping_allocation_draft_lines] ' + lR, stage: 'schema', zero_write: true });

  // F1-7N-FB-4F-B3 - the LIVE shape, read once, and the typed refusal for anything it cannot hold. This runs
  // BEFORE any validation that could write, so a value with nowhere to go fails the request with zero mutation
  // instead of being dropped on the way through the writer.
  var hNames = sadLiveHeaderNames_(hSh), lNames = sadLiveHeaderNames_(lSh);
  var schemaRefusal = sadSchemaRefusal_(header, body.lines || [], hNames, lNames);
  if (schemaRefusal) {
    return jsonResponse_({ success: false, error: schemaRefusal.error, stage: 'schema', zero_write: true, data: schemaRefusal });
  }
  var k4Ready = sadK4SchemaReady_(hNames);

  // pure batch validation (header completeness + line completeness + batch dedup + optional K2 guard).
  var vb = sadAtomicValidateBatch_(header, body.lines || [], body.enforce_k2_grouping === true);
  if (!vb.ok) return jsonResponse_({ success: false, error: vb.error, stage: vb.stage, zero_write: true, data: vb.data || null });
  var lines = vb.lines;

  // resolve the header id: explicit id, else the UNIFIED K2-or-K3 active-draft resolution (R6F2) — a route-complete
  // header keys on the 10-dim K2 group identity (CREATE returns the deterministic SADH-K2- id); a no-route scratchpad
  // falls back to K3. Fail closed on CONFLICT with ZERO mutation. This is the SAME identity generation uses.
  var allowReconcile = (body.allow_legacy_reconcile === true);
  var id = String(header.allocation_draft_id || '').trim();
  var found = id ? procurementFindRow_(hSh, 'allocation_draft_id', id) : null;
  // R6F2G (B): K2 group classification from the resolver's authoritative decision (CREATE/REUSE), else — for an
  // explicit-id edit — from the header's own group authority. Drives the K2-aware NEW-line id scheme below.
  var isK2Group = id ? sadIsK2Group_(undefined, id, header) : false;

  // ============================================================================================================
  // F1-7N-FB-4G-A2-R3 §B/§D/§F — THE INTENT CONTRACT ON THE ATOMIC PATH.
  //
  // A2-R2 put this on the two-call header writer. That writer cannot be atomic by construction: measured, a
  // successful header write followed by a refused line write (PLAN_LINE_INCOMPLETE) left 1 header and 0 lines
  // — an orphan zero-line header, which is one of the shapes now polluting the live table. §D.4 forbids
  // simulating atomicity with two calls, so + Add Route and every route edit come THROUGH HERE, where the
  // header and its line are validated together before the first write and compensated together after it.
  //
  // Three rules this path enforces that the resolver cannot:
  //   §B.2  an explicit CREATE is ALWAYS a new ticket. The resolver is not consulted, so a matching natural
  //         key can neither REUSE a row nor adopt a legacy one, and a K4 collision NEVER refuses.
  //   §F    a CREATE requires a persistable create_idempotency_key. Without the column there is no safe
  //         create, so it refuses rather than degrading to an unprotected one.
  //   §B.1  an UPDATE names its own row and updates it in place. It never falls back to CREATE, and the
  //         deterministic-id guard is not applied to it (A2-R2 §4: an id names the entity, not its contents).
  var sadIntent = String(body.intent || header.intent || '').trim();
  var atomicRouteIntent = !!(String(header.recommended_source_warehouse_id || '').trim() ||
    String(header.recommended_shipping_method || '').trim() ||
    String(header.recommended_destination_warehouse_id || '').trim() ||
    String(header.destination_marketplace || '').trim());
  var atomicStatus = String(header.status || 'draft').trim();
  // F1-7N-FB-4G-A2-R3 — AN EXPLICIT LEGACY ADOPTION IS A THIRD, ALREADY-DECLARED OPERATION.
  //
  // allow_legacy_reconcile === true is the USER's explicit migration authority (FB-4F-B6 §G): adopt the one
  // legacy header this route collides with. That is neither "create a new ticket" nor "update the row I name
  // by id" — it resolves by natural key on purpose — so requiring one of the two route intents of it would
  // break the adoption path B6 established. It is exempt from the intent REQUIREMENT and nothing else: a
  // CREATE_NEW_ROUTE carrying the flag is still refused as contradictory below, because an Add Route may never
  // drift into adopting an existing header (§4).
  var intentApplies = atomicRouteIntent && atomicStatus !== 'cancelled' && allowReconcile !== true;
  var createKey = String(body.create_idempotency_key || header.create_idempotency_key || '').trim();

  // F1-7N-FC-1B-E3-R4-A2-R1-R2 §2/§4 — THE AI GENERATION'S OWN INTENT.
  //
  // It is handled FIRST and separately because it is the one intent that must reach the deterministic K2
  // resolver below: it neither mints an identity (CREATE) nor names one (UPDATE), it RESOLVES one. Everything
  // the two manual intents do is untouched underneath.
  var isAiK2 = (sadIntent === SAD_AI_K2_INTENT_);
  var aiEvidence = null;
  if (intentApplies && isAiK2) {
    // §3 — a declaration is not authority. The router refuses this intent from any external request; this is
    // the second half of that gate, so an internal caller that has not done the work cannot use it either.
    aiEvidence = sadAiK2IntentEvidence_(body, header, lines, hNames);
    if (!aiEvidence.ok) {
      return jsonResponse_({ success: false, error: 'AI_ROUTE_INTENT_EVIDENCE_INSUFFICIENT',
        code: 'AI_ROUTE_INTENT_EVIDENCE_INSUFFICIENT', stage: 'intent', zero_write: true,
        data: { intent: sadIntent, missing: aiEvidence.missing, evidence: aiEvidence.evidence,
          message: 'UPSERT_AI_GENERATED_K2_ROUTE is server-owned and must arrive with complete generation evidence; '
            + aiEvidence.missing.length + ' fact(s) missing or contradictory (zero rows written)' } });
    }
    if (id) {
      // An AI upsert RESOLVES its identity. Naming one would let a caller point the deterministic write at an
      // arbitrary row, which is the whole thing the deterministic identity exists to prevent.
      return jsonResponse_({ success: false, error: 'ROUTE_INTENT_CONTRADICTORY', code: 'ROUTE_INTENT_CONTRADICTORY',
        stage: 'intent', zero_write: true, data: { intent: sadIntent, allocation_draft_id: id,
          message: 'UPSERT_AI_GENERATED_K2_ROUTE resolves its own deterministic K2 identity and must not name an allocation_draft_id (zero rows written)' } });
    }
    // The execution key is PERSISTED where a create key lives, so a replay has a second, independent witness
    // beside the K2 identity. On a deployment whose header cannot hold it the upsert still proceeds — the K2
    // identity is the replay authority — and the result says the key was not stored rather than implying it was.
    if (aiEvidence.evidence.execution_key_persistable) createKey = aiEvidence.evidence.execution_key;
  }

  if (intentApplies && !isAiK2) {
    if (sadIntent !== 'UPDATE_EXISTING_ROUTE' && sadIntent !== 'CREATE_NEW_ROUTE') {
      return jsonResponse_({ success: false, error: 'ROUTE_INTENT_REQUIRED', code: 'ROUTE_INTENT_REQUIRED',
        stage: 'intent', zero_write: true, data: { received_intent: sadIntent,
          message: 'a route write must declare intent = UPDATE_EXISTING_ROUTE or CREATE_NEW_ROUTE; it is never inferred from whether a natural key matches (zero rows written)',
          server_owned_intents: [SAD_AI_K2_INTENT_] } });
    }
    if (sadIntent === 'UPDATE_EXISTING_ROUTE' && !id) {
      return jsonResponse_({ success: false, error: 'ROUTE_INTENT_CONTRADICTORY', code: 'ROUTE_INTENT_CONTRADICTORY',
        stage: 'intent', zero_write: true, data: { intent: sadIntent, message: 'UPDATE_EXISTING_ROUTE requires the allocation_draft_id of the route being updated (zero rows written)' } });
    }
    if (sadIntent === 'CREATE_NEW_ROUTE' && id) {
      return jsonResponse_({ success: false, error: 'ROUTE_INTENT_CONTRADICTORY', code: 'ROUTE_INTENT_CONTRADICTORY',
        stage: 'intent', zero_write: true, data: { intent: sadIntent, allocation_draft_id: id, message: 'CREATE_NEW_ROUTE must not name an existing allocation_draft_id (zero rows written)' } });
    }
    if (sadIntent === 'CREATE_NEW_ROUTE' && allowReconcile) {
      return jsonResponse_({ success: false, error: 'ROUTE_INTENT_CONTRADICTORY', code: 'ROUTE_INTENT_CONTRADICTORY',
        stage: 'intent', zero_write: true, data: { intent: sadIntent, message: 'CREATE_NEW_ROUTE cannot carry allow_legacy_reconcile: an explicit Add Route never adopts an existing header (zero rows written)' } });
    }
    if (sadIntent === 'UPDATE_EXISTING_ROUTE' && !found) {
      return jsonResponse_({ success: false, error: 'ALLOCATION_DRAFT_NOT_FOUND', code: 'ALLOCATION_DRAFT_NOT_FOUND',
        stage: 'validation', zero_write: true, data: { allocation_draft_id: id } });
    }
    if (sadIntent === 'CREATE_NEW_ROUTE') {
      if (!createKey) {
        return jsonResponse_({ success: false, error: 'ROUTE_CREATE_IDEMPOTENCY_KEY_REQUIRED',
          code: 'ROUTE_CREATE_IDEMPOTENCY_KEY_REQUIRED', stage: 'intent', zero_write: true,
          data: { message: 'CREATE_NEW_ROUTE requires a stable create_idempotency_key so a retried click cannot mint a second ticket (zero rows written)' } });
      }
      if (!sadCreateIdempotencyReady_(hNames)) {
        // §F.7 — NEVER degrade to a create with no idempotency protection.
        return jsonResponse_({ success: false, error: 'ROUTE_CREATE_IDEMPOTENCY_NOT_PERSISTABLE',
          code: 'ROUTE_CREATE_IDEMPOTENCY_NOT_PERSISTABLE', stage: 'schema', zero_write: true,
          data: { column: 'create_idempotency_key', table: 'shipping_allocation_drafts',
            message: 'this deployment cannot store a create idempotency key, so a retried Add Route could not be told from a second one. Run the create_idempotency_key migration first. Nothing was written.' } });
      }
      // §F.4 — THE REPLAY. An earlier attempt of this same click already committed: return ITS ids, write nothing.
      var prior = sadFindHeaderByCreateKey_(hSh, createKey);
      if (prior && prior.allocation_draft_id) {
        var priorLines2 = sadReadLinesForDraft_(lSh, prior.allocation_draft_id);
        return jsonResponse_({ success: true, reused: true, data: {
          allocation_draft_id: prior.allocation_draft_id, outcome: 'CREATE_REPLAYED', zero_write: true,
          intent: 'CREATE_NEW_ROUTE', create_idempotency_key: createKey,
          line_count: priorLines2.length,
          persisted_lines: priorLines2.map(function (pl) {
            return { allocation_draft_line_id: String(pl.allocation_draft_line_id || ''),
              allocation_draft_id: prior.allocation_draft_id, sku: String(pl.sku || ''),
              site_sku: String(pl.site_sku || ''), window_code: String(pl.window_code || '') };
          }),
          reuse_basis: 'CREATE_IDEMPOTENCY_KEY' } });
      }
      // §B.2 — a NEW ticket. The resolver is deliberately NOT consulted, so no REUSE, no legacy adoption and
      // no collision refusal is possible. An identical route becomes a second ticket with its own identity.
      id = sadMintNewHeaderId_(hSh, header, k4Ready);
      if (!id) {
        return jsonResponse_({ success: false, error: 'ROUTE_IDENTITY_MINT_FAILED', code: 'ROUTE_IDENTITY_MINT_FAILED',
          stage: 'header', zero_write: true, data: {} });
      }
      found = null;
      isK2Group = sadIsK2Group_(true, id, header);
    }
  }

  // §4 — the AI K2 intent lands HERE, on the SAME deterministic identity authority manual saves and the
  // pre-A2-R3 generation path both used. No second hash, no parallel identity family: a first run gets
  // CREATE with a deterministic SADH-K2- id, and a replay gets REUSE of that very row.
  if (!id && (!intentApplies || isAiK2)) {
    var res = sadResolveActiveDraftK2OrK3_(hSh, header, { allowLegacyReconcile: allowReconcile, k4Ready: k4Ready });
    if (res.status === 'CONFLICT') return jsonResponse_({ success: false, error: 'BLOCKED_CONFLICT — more than one Active Draft for this ' + (res.k2 ? 'shipment group (K2)' : 'scope (K3)') + ' (zero rows written)', stage: 'header', zero_write: true, data: { conflictIds: res.conflictIds, k2: res.k2 } });
    if (res.status === 'BLOCK') return jsonResponse_({ success: false, error: res.reason + ' — ' + sadResolveBlockMessage_(res.reason) + ' (zero rows written)', stage: 'header', zero_write: true, data: { reason: res.reason, existing_id: res.id || null } });
    isK2Group = sadIsK2Group_(res.k2, res.id, header);
    if (res.status === 'REUSE') { id = res.id; found = procurementFindRow_(hSh, 'allocation_draft_id', id); }
    else if (res.status === 'CREATE' && res.id) {
      // F1-7N-FC-1B-E3-R4-A2-R1-R2 §6 — A DETERMINISTIC ID THAT A TERMINAL ROW ALREADY HOLDS.
      //
      // The resolver considers ACTIVE rows only, which is right: a cancelled plan must never be revived or
      // resurrected by a later run. But the id it then hands back for the INSERT is DETERMINISTIC, so if the
      // operator cancelled the previous plan for this exact route, that id is already taken — and inserting
      // anyway produced TWO ROWS WITH THE SAME allocation_draft_id (measured: one cancelled, one draft).
      // Nothing was revived, and the identity became ambiguous instead: procurementFindRow_ returns the FIRST
      // match, so every later lookup by id would find the CANCELLED row and refuse as terminal, leaving the
      // new active plan unreachable by its own name.
      //
      // Neither reviving the cancelled row nor writing beside it is acceptable, so this refuses and says so.
      // Deliberately NOT auto-minting a fresh id: which row an operator meant after cancelling one is a
      // business decision, and a writer that silently invents a second identity is how a table ends up with
      // two plans for one route.
      var _held = procurementFindRow_(hSh, 'allocation_draft_id', res.id);
      if (_held) {
        var _hs = _held.col('status');
        var _hst = _hs !== -1 ? String(hSh.getRange(_held.row, _hs + 1).getValue()).trim().toLowerCase() : '';
        return jsonResponse_({ success: false, error: 'ROUTE_IDENTITY_HELD_BY_TERMINAL_DRAFT',
          code: 'ROUTE_IDENTITY_HELD_BY_TERMINAL_DRAFT', stage: 'header', zero_write: true,
          data: { allocation_draft_id: res.id, held_status: _hst,
            message: 'the deterministic identity for this route is already held by a ' + (_hst || 'non-active')
              + ' draft. It is not revived and nothing was written; a new plan for this route needs an explicit '
              + 'decision about the cancelled one.' } });
      }
      id = res.id;   // K2/K4 deterministic id → INSERT with it (found stays null)
    }
  }
  if (found) {
    var cS = found.col('status'); var st = cS !== -1 ? String(hSh.getRange(found.row, cS + 1).getValue()).trim().toLowerCase() : '';
    if (SAD_TERMINAL_STATUSES_[st]) return jsonResponse_({ success: false, error: 'IMMUTABLE_TERMINAL_STATUS:' + st, stage: 'terminal', zero_write: true });
    // F1-7N-FB-4G-A2-R3 §B.1 — the applied station must be the one that OWNS the row. Scope identity comes from
    // the stored header, never from the declaration: a payload cannot assert a station, only fail to match it.
    var aScopeWant = String(body.applied_scope_key || header.applied_scope_key || '').trim().toLowerCase();
    if (aScopeWant) {
      var aStored = sadRowToObject_(hSh, found.row);
      var aScopeHave = [String(aStored.company || ''), String(aStored.country || ''), String(aStored.marketplace || '')].join('|').toLowerCase();
      if (aScopeWant !== aScopeHave) {
        return jsonResponse_({ success: false, error: 'APPLIED_SCOPE_MISMATCH', code: 'APPLIED_SCOPE_MISMATCH',
          stage: 'validation', zero_write: true, data: { allocation_draft_id: id, stored_scope: aScopeHave, applied_scope: aScopeWant } });
      }
    }
    // A: editing an existing route-INCOMPLETE (legacy) row is fail-closed unless an explicit USER migration is requested.
    // FB-4A §D — the REQUEST header goes to the guard here too. The AI-Plan generation path runs through THIS core,
    // and it is the path that mints a K2 id over the four route dimensions the generation engine leaves blank, so it
    // is the one most exposed to the id-drift trap the semantic comparison closes.
    // F1-7N-FB-4G-A2-R3 §B.1 / A2-R2 §4 — A DECLARED UPDATE IS NOT SUBJECT TO THE DETERMINISTIC-ID GUARD.
    //
    // sadLegacyReconcileReason_ refuses an SADH-K2- row whose id no longer hashes to its own current field
    // values. That is the NORMAL state of any header that has ever been legitimately edited, so applying it to
    // an explicit UPDATE classified every legal edit as data corruption. An id names the ENTITY, not its
    // contents. The guard still protects the paths that resolve a row by natural key, where "is this row my
    // own shipment group?" is a real question.
    if (sadIntent !== 'UPDATE_EXISTING_ROUTE') {
      var legR = sadLegacyReconcileReason_(hSh, found, allowReconcile, header || null);
      if (legR) return jsonResponse_({ success: false, error: legR + ' — ' + sadReconcileMessage_(legR) + ' (zero rows written)', stage: 'header', zero_write: true, data: { reason: legR, existing_id: id } });
    }
  }

  var now = procurementTimestamp_();
  var actor = String(header.created_by || 'inventory-replenishment').trim();
  var status = String(header.status || 'draft').trim(); if (!SAD_STATUSES_[status]) status = 'draft';
  var newHeaderCreated = false;
  // F1-7N-FB-4G-A2-R3 §G.5 — every line this call persisted, by identity. The client binds these back to the
  // DOM row that asked, so a created route becomes a persisted instance whose later edits are UPDATEs. Without
  // it a created row would hold a draft id and NO line id, routeIsPersisted would stay false, and A2-R1's
  // dirty guard would block Submit for a route that IS in fact saved.
  var atomicPersistedLines = [];

  // ---- F1-7N-FA-3C-R6F2A (B): REUSE vs REGENERATE vs CONFLICT for an existing K2 group ----------------------
  var outcome = 'CREATE', priorVersion = '', nextVersion = '';
  if (found) {
    var priorHeaderObj = sadRowToObject_(hSh, found.row);
    priorVersion = sadFpVal_(priorHeaderObj.draft_version);
    // optimistic token (missing or stale → CONFLICT, zero write)
    // F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4-R2 — read from the header FIRST and the documented top-level field
    // second, and treat a BLANK as absent rather than as the number zero.
    var sadExpDeclared = (header.expected_draft_version != null
        && String(header.expected_draft_version).trim() !== '') ? header.expected_draft_version
      : ((body && body.expected_draft_version != null
        && String(body.expected_draft_version).trim() !== '') ? body.expected_draft_version : null);
    // A DECLARED UPDATE MUST DECLARE WHAT IT EXPECTS. Only for UPDATE_EXISTING_ROUTE: a CREATE has no prior
    // version, and a cancel carries no route intent. Zero write, typed, and it publishes the current version
    // so the client can adopt it and re-offer the edit rather than guess.
    if (sadIntent === 'UPDATE_EXISTING_ROUTE' && sadExpDeclared === null) {
      return jsonResponse_({ success: false,
        error: 'MISSING_OPTIMISTIC_TOKEN — an UPDATE_EXISTING_ROUTE must declare expected_draft_version;'
          + ' the row named is at ' + priorVersion + ' (zero rows written). Reload the Execution Plan and'
          + ' make the edit again — an out-of-date page cannot state which version it read.',
        code: 'MISSING_OPTIMISTIC_TOKEN', stage: 'conflict', zero_write: true,
        data: { allocation_draft_id: id, intent: sadIntent, current: priorVersion,
          current_draft_version: priorVersion, expected: null } });
    }
    if (sadExpDeclared != null && sadFpVal_(sadExpDeclared) !== priorVersion) {
      // F1-7N-FB-4G-A2-R3-R1 §F3 — this refusal named itself only inside the prose. It now carries the typed
      // code as a field like every other refusal, and it publishes the CURRENT version so the client can adopt
      // it and re-offer the edit instead of retrying the same stale number for ever.
      return jsonResponse_({ success: false, error: 'STALE_OPTIMISTIC_TOKEN — expected draft_version ' + sadFpVal_(sadExpDeclared) + ' but current is ' + priorVersion + ' (zero rows written)', code: 'STALE_OPTIMISTIC_TOKEN', stage: 'conflict', zero_write: true, data: { expected: sadFpVal_(sadExpDeclared), current: priorVersion, allocation_draft_id: id, current_draft_version: priorVersion } });
    }
    var priorLines = sadReadLinesForDraft_(lSh, id);
    var priorFp = sadK2PayloadFingerprint_(priorHeaderObj, priorLines);
    var incFp = sadK2PayloadFingerprint_(header, lines);
    // R6F2G6 — REUSE (zero write) when the raw fingerprints match OR the payload is representation-equivalent (a
    // Sheets Date/number coercion is NOT a content change). Both return BEFORE the first business-table mutation.
    if (priorFp === incFp || sadK2SemanticPayloadEqual_(priorHeaderObj, priorLines, header, lines)) {
      return jsonResponse_({ success: true, reused: true, data: { allocation_draft_id: id, outcome: 'REUSED', draft_version: priorVersion, line_count: priorLines.length, zero_write: true, reuse_basis: (priorFp === incFp ? 'FINGERPRINT_EQUAL' : 'SEMANTIC_EQUIVALENT@' + SAD_K2_SEM_CONTRACT_) } });
    }
    outcome = 'REGENERATE';
    nextVersion = String((parseInt(priorVersion, 10) || 1) + 1);   // increment EXACTLY once
  }

  // ---- WRITE PHASE (header first, then all lines) — one lock is already held by the public handler ------------
  if (found) {
    (function () {
      function setCol(name, val) { var c = found.col(name); if (c !== -1) hSh.getRange(found.row, c + 1).setValue(val); }
      setCol('status', status);
      // B3 - destination_marketplace joins the route fields an edit may change. setCol is a no-op when the
      // column is absent, and that silence is exactly what sadSchemaRefusal_ has already made impossible to
      // reach with a value in hand: a supplied marketplace with no column refused the request above.
      ['recommended_source_warehouse_id', 'recommended_destination_warehouse_id', 'recommended_source_warehouse_code_snapshot',
        'recommended_destination_warehouse_code_snapshot', 'recommendation_group_no', 'recommended_shipping_method',
        'recommended_last_mile_delivery', 'destination_marketplace'].forEach(function (f) { if (header[f] != null) setCol(f, String(header[f])); });
      // REGENERATE: adopt new calculation evidence + bump draft_version EXACTLY once. note is USER-owned (not overwritten).
      ['calculation_run_id', 'formula_version', 'calculated_at', 'source_data_as_of'].forEach(function (f) { if (header[f] != null && String(header[f]).trim() !== '') setCol(f, String(header[f])); });
      // ADDENDUM — a REGENERATE is this run's output, so the row's owning run becomes THIS run. Excluded from
      // SAD_K2_HEADER_FP_, so stamping it never turns an otherwise-identical payload into a false content change
      // (a REUSE returns before the write phase and correctly keeps the run that created the row).
      if (header.generation_run_id != null && String(header.generation_run_id).trim() !== '') setCol('generation_run_id', String(header.generation_run_id).trim());
      if (nextVersion) setCol('draft_version', nextVersion);
      setCol('updated_by', actor); setCol('updated_at', now);
    })();
  } else {
    if (!id) id = 'SAD-' + Utilities.getUuid().substring(0, 10).toUpperCase();
    procurementAppendByHeader_(hSh, {
      allocation_draft_id: id, planning_cycle: String(header.planning_cycle || '').trim(),
      source_page: String(header.source_page || 'inventory_replenishment').trim(),
      company: String(header.company || '').trim(), country: String(header.country || '').trim(),
      marketplace: String(header.marketplace || '').trim(), status: status,
      recommended_source_warehouse_id: String(header.recommended_source_warehouse_id || '').trim(),
      recommended_destination_warehouse_id: String(header.recommended_destination_warehouse_id || '').trim(),
      recommended_source_warehouse_code_snapshot: String(header.recommended_source_warehouse_code_snapshot || '').trim(),
      recommended_destination_warehouse_code_snapshot: String(header.recommended_destination_warehouse_code_snapshot || '').trim(),
      recommendation_group_no: String(header.recommendation_group_no || '').trim(),
      recommended_shipping_method: String(header.recommended_shipping_method || '').trim(),
      recommended_last_mile_delivery: String(header.recommended_last_mile_delivery || '').trim(),
      // F1-7N-FB-4G-A2-R3 §F.3 — STORED ON THE INSERT. This is the whole point of the column: it is what
      // lets a later retry of the same click be recognised as a replay instead of minting a second ticket.
      // procurementAppendByHeader_ writes by column NAME, so it is inert on a pre-migration sheet - and
      // unreachable with a value in hand, because a CREATE already refused above when the column is absent.
      create_idempotency_key: createKey,
      generation_type: String(header.generation_type || 'user_created').trim(),
      calculation_run_id: String(header.calculation_run_id || '').trim(),
      formula_version: String(header.formula_version || '').trim(),
      calculated_at: String(header.calculated_at || '').trim(),
      source_data_as_of: String(header.source_data_as_of || '').trim(),
      draft_version: String(header.draft_version || '1').trim(),
      // ADDENDUM — WRITE the lifecycle provenance. FB-4C stamped generation_run_id onto the header OBJECT in 61_
      // but this insert never carried it into the row, so no persisted row could ever have one and the lifecycle
      // could not have told one run from another even with the columns present. Written by header NAME
      // (procurementAppendByHeader_), so this is inert pre-migration and correct post-migration - it needs no
      // deployment ordering. The three expiration columns are deliberately left blank: a row is not expired.
      generation_run_id: String(header.generation_run_id || '').trim(),
      expired_at: '', expired_by_run_id: '', expiration_reason: '',
      // B3 - written by header NAME, so it is inert before the column exists and correct after it does. That
      // is the same property the lifecycle provenance above relies on, and it is why this needs no deployment
      // ordering of its own: the ORDERING that matters is the authority learning the column, which is above.
      destination_marketplace: String(header.destination_marketplace || '').trim(),
      created_by: actor, created_at: now, updated_by: actor, updated_at: now,
      submitted_by: '', submitted_at: '', cancelled_by: '', cancelled_at: '', cancel_reason: '',
      note: String(header.note || '').trim()
    });
    newHeaderCreated = true;
  }

  // lines — reuse the frozen per-line contract (heal blank id / EXEC_FIELDS / deterministic insert / terminal-skip),
  // mirroring sadUpsertLinesKeyedCore_. Wrapped so a write throw AFTER a new header triggers compensation.
  var created = 0, updated = 0, skipped = 0, writeErr = null;
  try {
    var EXEC_FIELDS = ['planned_qty', 'override_reason', 'line_status', 'route_no', 'units_per_carton', 'note', 'expected_arrival'];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var lineId = String(l.allocation_draft_line_id || '').trim();
      // FB-4B §B — the same canonical-first resolution the keyed core uses. "An existing primary key must never
      // be appended to" is a rule about the TABLE, so the AI-Plan atomic path obeys it too.
      var canonicalLineId = sadCanonicalLineId_(isK2Group, id, l);
      var lf = lineId ? procurementFindRow_(lSh, 'allocation_draft_line_id', lineId) : null;
      if (!lf) lf = procurementFindRow_(lSh, 'allocation_draft_line_id', canonicalLineId);
      if (!lf) lf = sadFindLineByNaturalKey_(lSh, id, l);
      if (!lf && String(l.line_status || '').trim().toLowerCase() === 'cancelled') { skipped++; continue; }
      if (lf) {
        var cLS = lf.col('line_status'); var curLS = cLS !== -1 ? String(lSh.getRange(lf.row, cLS + 1).getValue()).trim().toLowerCase() : '';
        if (SAD_TERMINAL_LINE_STATUSES_[curLS]) { skipped++; continue; }   // FB-4C: `expired` is terminal too
        var cId0 = lf.col('allocation_draft_line_id');
        if (cId0 !== -1) { var curId0 = String(lSh.getRange(lf.row, cId0 + 1).getValue()).trim(); if (!curId0) lSh.getRange(lf.row, cId0 + 1).setValue(sadNewLineId_(isK2Group, id, l)); }
        (function (found2, line) {
          function put(name, val) { var c = found2.col(name); if (c !== -1) lSh.getRange(found2.row, c + 1).setValue(String(val)); }
          if (outcome === 'REGENERATE') {
            // C: system fields adopted; planned_qty per ownership; note + user override PRESERVED (never restore an old AI note).
            var patch = sadRegenerateLinePatch_(sadRowToObject_(lSh, found2.row), line);
            // F1-7N-FB-4G-A2-R3 §8 — A USER EDIT'S QUANTITY IS THE AUTHORITY; A REGENERATION'S IS NOT.
            //
            // sadRegenerateLinePatch_ deliberately PRESERVES an operator-owned planned_qty: an AI-Plan regeneration
            // must never overwrite a quantity the operator set. That rule is unchanged and still applies to every
            // caller that carries no route intent.
            //
            // But this path now also carries the operator's OWN edit (intent = UPDATE_EXISTING_ROUTE / CREATE_NEW_
            // ROUTE), and there the incoming planned_qty IS the operator speaking. Measured before this: editing a
            // route's Qty through the atomic writer left the stored quantity untouched, because the preserve rule
            // read the edit as a regeneration trying to overwrite the user. The intent is what tells the two apart,
            // which is exactly why it is declared rather than inferred.
            if ((sadIntent === 'UPDATE_EXISTING_ROUTE' || sadIntent === 'CREATE_NEW_ROUTE') &&
                line.planned_qty != null && String(line.planned_qty).trim() !== '') {
              patch.planned_qty = String(procurementNum_(line.planned_qty));
            }
            for (var pk in patch) if (patch.hasOwnProperty(pk)) put(pk, patch[pk]);
          } else {
            // manual edit through the atomic endpoint: the user's Execution-Plan fields overwrite when provided.
            EXEC_FIELDS.forEach(function (name) { if (line[name] != null) put(name, line[name]); });
            SAD_RECOMMENDATION_FIELDS_.forEach(function (f) { if (line[f] != null && line[f] !== '') put(f, line[f]); });
          }
          var uc = found2.col('updated_at'); if (uc !== -1) lSh.getRange(found2.row, uc + 1).setValue(now);
        })(lf, l);
        updated++;
      atomicPersistedLines.push({ allocation_draft_line_id: lineId, allocation_draft_id: id,
        sku: String(l.sku || ''), site_sku: String(l.site_sku || ''), window_code: String(l.window_code || ''),
        resolution: 'UPDATED' });
      } else {
        // R6F2G (B): a K2 group ALWAYS mints the canonical K2 line id from the natural key (a caller-supplied arbitrary
        // id is never trusted to name a new K2 line); a generic/legacy draft honors an explicit id, else mints SADL-.
        lineId = canonicalLineId;
        // Defence in depth: never append onto an id that already exists.
        if (procurementFindRow_(lSh, 'allocation_draft_line_id', lineId)) {
          throw new Error('LINE_PRIMARY_KEY_ALREADY_EXISTS:' + lineId);
        }
        var recQty = (l.recommended_qty != null && l.recommended_qty !== '') ? procurementNum_(l.recommended_qty) : '';
        var planned = (l.planned_qty != null && l.planned_qty !== '') ? procurementNum_(l.planned_qty) : (recQty !== '' ? recQty : '');
        var rowObj = { allocation_draft_line_id: lineId, allocation_draft_id: id, created_at: now, updated_at: now, planned_qty: planned, recommended_qty: recQty };
        SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_.forEach(function (h) { if (h in rowObj) return; if (l[h] != null) rowObj[h] = String(l[h]); });
        procurementAppendByHeader_(lSh, rowObj);
        created++;
      atomicPersistedLines.push({ allocation_draft_line_id: lineId, allocation_draft_id: id,
        sku: String(l.sku || ''), site_sku: String(l.site_sku || ''), window_code: String(l.window_code || ''),
        resolution: 'CREATED' });
      }
    }
  } catch (e3) { writeErr = e3; }

  if (writeErr) {
    if (newHeaderCreated) {
      // COMPENSATE the just-created header (soft-cancel; NEVER hard-delete) + COMMITTED_UNVERIFIED.
      var cf = procurementFindRow_(hSh, 'allocation_draft_id', id);
      if (cf) { (function () { function setC(n, v) { var c = cf.col(n); if (c !== -1) hSh.getRange(cf.row, c + 1).setValue(v); } setC('status', 'cancelled'); setC('cancelled_by', actor); setC('cancelled_at', now); setC('cancel_reason', 'R6F1_ATOMIC_COMPENSATION_LINE_WRITE_FAILED'); setC('updated_at', now); })(); }
      return jsonResponse_({ success: false, error: 'COMMITTED_UNVERIFIED — new Header created then a line write failed; the exact Header was soft-cancelled for audit (no hard delete). ' + (writeErr.message || writeErr), stage: 'lines', data: { allocation_draft_id: id, compensated: true, lines_committed: created + updated } });
    }
    return jsonResponse_({ success: false, error: 'RECONCILIATION_REQUIRED — existing Draft; a line write failed and existing data was preserved (no delete). ' + (writeErr.message || writeErr), stage: 'lines', data: { allocation_draft_id: id, lines_committed: created + updated } });
  }
  // F1-7N-FB-4G-A2-R3-R1 §F3 — `created` / `updated` here are LINE COUNTS (see `var created = 0, updated = 0`
  // above), NOT the booleans the two-call header writer returns under the same two names. A client that reads
  // them as a header classification sees `1` where it expects `true` and cannot acknowledge a write that in
  // fact committed — which is exactly what made every route save report OUTCOME UNKNOWN in production. The
  // counts keep their names for the callers that already read them; the HEADER classification is stated
  // separately and unambiguously, and the line counts are also republished under names that cannot be misread.
  return jsonResponse_({ success: true, data: { allocation_draft_id: id, outcome: (newHeaderCreated ? 'CREATED' : 'REGENERATED'), created_header: newHeaderCreated, draft_version: (nextVersion || (found ? priorVersion : String(header.draft_version || '1').trim())), line_count: created + updated, created: created, updated: updated, skipped: skipped,
    header_created: newHeaderCreated === true, header_updated: newHeaderCreated !== true,
    lines_created: created, lines_updated: updated, lines_skipped: skipped,
    intent: sadIntent || '', create_idempotency_key: createKey || '',
    persisted_lines: atomicPersistedLines,
    persisted_headers: [{ allocation_draft_id: id, resolution: (newHeaderCreated ? 'CREATED' : 'UPDATED') }] } });
}

// ---- submitShippingAllocationDrafts (DEPRECATED alias) ------------
// F1-7N-FA-4B — the status-only "mark submitted" stub is RETIRED as an independent boundary. There is exactly ONE
// production Submit authority: handleSubmitAllocationDraftsToShippingPlans_. This name is kept only as a deprecated
// compatibility alias that DELEGATES to the canonical authority (which now creates the Weekly Shipping Plan and
// transitions the drafts atomically, instead of merely stamping status). No UI caller exists; remove after controlled
// live validation.
function handleSubmitShippingAllocationDrafts_(body) {
  body = body || {};
  return handleSubmitAllocationDraftsToShippingPlans_({ allocation_draft_ids: body.allocation_draft_ids || body.draft_ids || [],
    expected_versions: body.expected_versions, execution_key: body.execution_key || body.submit_batch_id, submitted_by: body.submitted_by,
    source: body.source, _deprecated_alias: 'submitShippingAllocationDrafts' });
}

// ============================================================
// F1-7N-FA-4B — THE canonical Inventory AI Plan Submit authority: shipping_allocation_drafts → Weekly Shipping Plan.
// SERVER-OWNED: re-reads shipping_allocation_drafts + shipping_allocation_draft_lines (NEVER trusts frontend-authored
// plan lines), validates, derives the shipping-plan payload from the persisted drafts, and delegates the WRITE to the
// single shipping_plans authority shippingPlanCommitFromLines_ (11_). Idempotent (execution key), ScriptLock-serialized,
// readback-verified. Drafts transition to `submitted` ONLY after the plan is durably committed and read back. Does NOT
// create shipments (Shipping Plan → Shipment remains a later approval boundary). Body:
//   { allocation_draft_ids:[], expected_versions?:{id:draft_version}, execution_key?, submitted_by?, source? }
// ============================================================
function handleSubmitAllocationDraftsToShippingPlans_(body) {
  body = body || {};
  var ids = (body.allocation_draft_ids || body.draft_ids || []).map(function (x) { return String(x || '').trim(); }).filter(String);
  if (!ids.length) return jsonResponse_({ success: false, error: 'allocation_draft_ids required', code: 'INPUT_MISSING_DRAFT_IDS', stage: 'input', zero_write: true });
  var lock = LockService.getScriptLock(), locked = false;
  try { locked = lock.tryLock(30000); } catch (e) { return jsonResponse_({ success: false, error: 'Lock error: ' + (e && e.message ? e.message : e), code: 'LOCK_ERROR', stage: 'lock', zero_write: true }); }
  if (!locked) return jsonResponse_({ success: false, error: 'IN_PROGRESS_SAME_EXECUTION_KEY — another Submit is in progress for this scope; read back by execution key rather than retrying.', code: 'IN_PROGRESS_SAME_EXECUTION_KEY', stage: 'lock', zero_write: true, data: { allocation_draft_ids: ids } });
  try { return jsonResponse_(sadSubmitToShippingPlansCore_(SpreadsheetApp.getActiveSpreadsheet(), body, ids)); }
  finally { try { lock.releaseLock(); } catch (e2) { /* best-effort */ } }
}

// ============================================================================================================
// F1-7N-FB-3C §I — EXACT SITE-INVENTORY OUTPUT VERIFICATION.
// ------------------------------------------------------------------------------------------------------------
// FB-3B added the two station-scope gates (MIXED_SITE_PAYLOAD / APPLIED_SCOPE_MISMATCH) and the existing core
// already read the committed plan back to confirm the DRAFT TRANSITION. What neither of them proved is that the
// committed shipping_plan_lines actually carry THE QUANTITIES THE OPERATOR SAW. The plan writer returning
// success is not that proof, and a plan whose line quantities silently came from a Suggested Qty rather than the
// user's planned_qty is precisely the failure this project has already been bitten by once.
//
// So: for every FROZEN route line this submit derived, verify against the committed rows that
//   * exactly ONE shipping_plan_lines row exists for (shipping_plan_id, sku, site_sku);
//   * requested_qty equals the frozen route planned_qty EXACTLY — never rounded, never "at least";
//   * the line belongs to a plan whose company/country/marketplace is the ONE applied station;
//   * no line exists that the frozen route set did not authorise (that is how "no other site row created" is
//     actually proven rather than assumed);
//   * the plan-level requested_qty total equals the sum of the verified lines.
// PURE over the read rows, so the regression suite executes this function rather than trusting a description of
// it. It is only ever called AFTER the canonical writer has committed, and it WRITES NOTHING.
// ------------------------------------------------------------------------------------------------------------
function sadVerifyShippingPlanOutput_(expectedLines, planIds, planRows, planLineRows, appliedStation) {
  function S(v) { return String(v == null ? '' : v).trim(); }
  function U(v) { return S(v).toUpperCase(); }
  function L(v) { return S(v).toLowerCase(); }
  function N(v) { var t = S(v); if (t === '') return null; var n = Number(t.replace(/,/g, '')); return isFinite(n) ? n : null; }

  var out = { ok: true, failures: [], verified_lines: 0, verified_qty: 0, plans_checked: 0 };
  var idSet = {};
  (planIds || []).forEach(function (id) { if (S(id)) idSet[S(id)] = 1; });
  var plans = (planRows || []).filter(function (p) { return idSet[S(p && p.shipping_plan_id)] === 1; });
  out.plans_checked = plans.length;
  if (!plans.length) { out.ok = false; out.failures.push({ code: 'SHIPPING_PLAN_HEADER_NOT_FOUND', plan_ids: Object.keys(idSet) }); return out; }

  // (1) every committed plan must belong to the ONE applied station.
  var wantC = U(appliedStation && appliedStation.company), wantCo = U(appliedStation && appliedStation.country), wantM = L(appliedStation && appliedStation.marketplace);
  plans.forEach(function (p) {
    if (wantCo && U(p.country) !== wantCo) { out.failures.push({ code: 'PLAN_COUNTRY_MISMATCH', shipping_plan_id: S(p.shipping_plan_id), found: S(p.country), expected: S(appliedStation.country) }); }
    if (wantM && L(p.marketplace) !== wantM) { out.failures.push({ code: 'PLAN_MARKETPLACE_MISMATCH', shipping_plan_id: S(p.shipping_plan_id), found: S(p.marketplace), expected: S(appliedStation.marketplace) }); }
    if (wantC && U(p.company) !== wantC) { out.failures.push({ code: 'PLAN_COMPANY_MISMATCH', shipping_plan_id: S(p.shipping_plan_id), found: S(p.company), expected: S(appliedStation.company) }); }
  });

  var mine = (planLineRows || []).filter(function (l) { return idSet[S(l && l.shipping_plan_id)] === 1; });
  var byKey = {};
  mine.forEach(function (l) {
    var k = [U(l.sku), U(l.site_sku)].join('|');
    (byKey[k] = byKey[k] || []).push(l);
  });

  // (2) every FROZEN route line must appear exactly once, with the exact frozen quantity.
  //
  // F1-7N-FB-4D §B5 — MATCHED AS A MULTISET PER (sku, site_sku), because ONE SKU CAN LEGITIMATELY HOLD SEVERAL
  // ROUTES. Route is a HEADER dimension and deliberately not part of line identity, so Route A (Sea) and Route B
  // (Air) for one SKU share the same (sku, site_sku) and commit two plan lines under two plans. Keying on
  // (sku, site_sku) alone therefore called every `+ Add Route` plan PLAN_LINE_DUPLICATED — reporting a correctly
  // committed plan as corrupt, after it had already been written. Comparing the multiset of expected quantities
  // against the multiset of committed ones proves the same contract (one committed line per frozen route line, at
  // the exact frozen quantity) at the right grain, and for a single route it reduces to exactly the old check.
  var expectedKeys = {};
  var expectedByKey = {};
  (expectedLines || []).forEach(function (e) {
    var k = [U(e.sku), U(e.site_sku)].join('|');
    expectedKeys[k] = true;
    (expectedByKey[k] = expectedByKey[k] || []).push(e);
  });
  function qtyList(arr, field) {
    return arr.map(function (x) { var n = N(x[field]); return n == null ? null : Number(n); })
      .sort(function (a, b) { return (a === null ? -1 : a) - (b === null ? -1 : b); });
  }
  Object.keys(expectedByKey).forEach(function (k) {
    var want = expectedByKey[k], found = byKey[k] || [];
    var sku = S(want[0].sku), siteSku = S(want[0].site_sku);
    if (found.length < want.length) {
      var wantMissing = qtyList(want, 'requested_qty');
      out.failures.push({ code: 'PLAN_LINE_MISSING', sku: sku, site_sku: siteSku,
        expected_line_count: want.length, found_line_count: found.length,
        expected_qty: (wantMissing.length === 1 ? wantMissing[0] : wantMissing) });
      return;
    }
    if (found.length > want.length) {
      out.failures.push({ code: 'PLAN_LINE_DUPLICATED', sku: sku, site_sku: siteSku, count: found.length,
        expected_line_count: want.length,
        plan_ids: found.map(function (l) { return S(l.shipping_plan_id); }) });
      return;
    }
    var missingId = found.filter(function (l) { return !S(l.shipping_plan_line_id); });
    if (missingId.length) { out.failures.push({ code: 'PLAN_LINE_ID_MISSING', sku: sku, site_sku: siteSku }); return; }
    var wantQ = qtyList(want, 'requested_qty'), gotQ = qtyList(found, 'requested_qty');
    var mismatch = false;
    for (var qi = 0; qi < wantQ.length; qi++) { if (gotQ[qi] === null || Number(gotQ[qi]) !== Number(wantQ[qi])) { mismatch = true; break; } }
    if (mismatch) {
      // The user's planned_qty is the authority. A mismatch here is exactly the "Suggested Qty replaced the
      // user quantity" failure mode, so it is named rather than tolerated.
      out.failures.push({ code: 'PLAN_LINE_QUANTITY_MISMATCH', sku: sku, site_sku: siteSku,
        expected_user_planned_qty: (wantQ.length === 1 ? wantQ[0] : wantQ),
        found_requested_qty: (gotQ.length === 1 ? gotQ[0] : gotQ),
        detail: 'The committed plan line(s) do not carry the frozen user planned quantities.' });
      return;
    }
    out.verified_lines += want.length;
    wantQ.forEach(function (q) { out.verified_qty += Number(q); });
  });

  // (3) no UNEXPECTED line — this is how "no other site row was created" is proven.
  mine.forEach(function (l) {
    var k = [U(l.sku), U(l.site_sku)].join('|');
    if (!expectedKeys[k]) {
      out.failures.push({ code: 'UNEXPECTED_PLAN_LINE', sku: S(l.sku), site_sku: S(l.site_sku),
        shipping_plan_id: S(l.shipping_plan_id), found_qty: N(l.requested_qty),
        detail: 'A committed plan line exists that the frozen Execution Plan routes did not authorise.' });
    }
  });

  // (4) plan totals equal the verified line sum.
  if (out.failures.length === 0) {
    var lineSum = 0;
    mine.forEach(function (l) { var n = N(l.requested_qty); if (n != null) lineSum += Number(n); });
    if (lineSum !== out.verified_qty) {
      out.failures.push({ code: 'PLAN_TOTAL_MISMATCH', committed_line_sum: lineSum, verified_line_sum: out.verified_qty });
    }
  }
  out.ok = out.failures.length === 0;
  return out;
}

// PURE-ish orchestration core (assumes the caller holds the ScriptLock). Returns a PLAIN result object.
function sadSubmitToShippingPlansCore_(ss, body, ids) {
  var hSh = procurementEnsureSheet_(ss, 'shipping_allocation_drafts', SHIPPING_ALLOCATION_DRAFTS_HEADERS_);
  var lSh = procurementEnsureSheet_(ss, 'shipping_allocation_draft_lines', SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_);
  var expectedVersions = body.expected_versions || {};
  var submittedBy = String(body.submitted_by || 'inventory-replenishment').trim();
  var source = String(body.source || 'inventory_ai_plan_submit').trim();
  var execKey = String(body.execution_key || body.submit_batch_id || '').trim();
  if (!execKey) execKey = 'SADSUB-' + sadFnv1a_(ids.slice().sort().join('|') + '::' + ids.slice().sort().map(function (id) { return String((expectedVersions || {})[id] == null ? '' : expectedVersions[id]); }).join('|')).toUpperCase();

  // ---- READ + VALIDATE every requested draft server-side (13-point gate; NEVER trust the frontend) ------
  var drafts = [], toTransition = [], alreadySubmitted = [], errors = [];
  var seenLineIds = {}, natKeys = {};
  ids.forEach(function (id) {
    var found = procurementFindRow_(hSh, 'allocation_draft_id', id);
    if (!found) { errors.push({ allocation_draft_id: id, reason: 'HEADER_NOT_FOUND' }); return; }              // (1) exact header exists
    var header = sadRowToObject_(hSh, found.row);
    var status = String(header.status || '').trim().toLowerCase();
    var isSubmitted = (status === 'submitted');
    if (status === 'cancelled') { errors.push({ allocation_draft_id: id, reason: 'DRAFT_CANCELLED' }); return; } // (13) not terminal-cancelled
    // F1-7N-FB-4C §F/§G.9 — an EXPIRED draft may never enter the Submit workset. It is refused with its OWN
    // reason rather than the generic STATUS_NOT_SUBMITTABLE, because "a newer AI Plan run replaced this" is a
    // different fact from "this status is not on the allow-list", and the operator's next action differs.
    if (status === 'expired') { errors.push({ allocation_draft_id: id, reason: 'DRAFT_EXPIRED_SUPERSEDED_BY_NEWER_AI_PLAN' }); return; }
    if (!isSubmitted && status !== 'draft' && status !== 'site_confirmed' && status !== 'partially_submitted') { errors.push({ allocation_draft_id: id, reason: 'STATUS_NOT_SUBMITTABLE:' + status }); return; } // (2)
    if (!isSubmitted && expectedVersions && expectedVersions[id] != null && String(expectedVersions[id]).trim() !== String(header.draft_version == null ? '' : header.draft_version).trim()) { errors.push({ allocation_draft_id: id, reason: 'STALE_VERSION', expected: String(expectedVersions[id]), current: String(header.draft_version) }); return; } // (12)
    // F1-7N-FB-4D §B5 — PROVENANCE IS CHECKED AGAINST WHAT THE DRAFT ACTUALLY IS.
    //
    // (10) and (11) demand the provenance of a COMPUTED recommendation: which planning cycle, which calculation
    // run, which formula version produced the number. A SYSTEM-GENERATED draft must have all of it. A
    // hand-authored Execution Plan route has NONE of it by construction — the page owns no planning cycle (that
    // control was deliberately removed as an implementation leak) and no calculation ran — so demanding it
    // refused every manual Add Route at Submit with PLANNING_CYCLE_MISSING after the routes had already
    // persisted and hydrated correctly. Zero plan rows, no way forward.
    //
    // Supplying a cycle from a clock is NOT the fix: planning_cycle is dimension 1 of the K2 group key, so it
    // would change the deterministic header id of every live route and create a second header for each one.
    //
    // A user_created draft's provenance is the OPERATOR, and that is stored. It is required here, so this is a
    // narrowing of WHICH provenance is demanded, never a waiver of provenance.
    var genType = String(header.generation_type == null ? '' : header.generation_type).trim().toLowerCase();
    var isUserAuthored = (genType === 'user_created');
    if (isUserAuthored) {
      if (!String(header.created_by || '').trim() || !String(header.created_at || '').trim()) {
        errors.push({ allocation_draft_id: id, reason: 'OPERATOR_PROVENANCE_INCOMPLETE' }); return;
      }
    } else if (!String(header.planning_cycle || '').trim()) {
      errors.push({ allocation_draft_id: id, reason: 'PLANNING_CYCLE_MISSING' }); return;   // (10)
    }
    // FB-4D §B5 — `header` here is the STORED ROW, so it is checked with the stored-row predicate. The comment
    // on this line has always claimed K2-awareness; the call did not have it, and an Amazon logical destination
    // therefore failed a gate its own write had passed.
    if (!isSubmitted && !sadStoredHeaderRouteIsComplete_(header)) { errors.push({ allocation_draft_id: id, reason: 'ROUTE_INCOMPLETE' }); return; }   // (9) complete route (stored-row aware)
    // (11) COMPUTED lineage — required of a system-generated draft, meaningless for a hand-authored one.
    if (!isUserAuthored && (!String(header.calculation_run_id || '').trim() || !String(header.formula_version || '').trim())) {
      errors.push({ allocation_draft_id: id, reason: 'LINEAGE_INCOMPLETE' }); return;
    }
    var lines = sadReadLinesForDraft_(lSh, id);
    if (!lines.length) { errors.push({ allocation_draft_id: id, reason: 'NO_LINES' }); return; }                // (3) exact linked lines
    var lineErr = null, shippable = [];
    for (var j = 0; j < lines.length; j++) {
      var ln = lines[j], lineId = String(ln.allocation_draft_line_id || '').trim();
      if (!lineId) { lineErr = 'LINE_ID_MISSING'; break; }
      if (seenLineIds[lineId]) { lineErr = 'DUPLICATE_LINE_ID:' + lineId; break; }                              // (5) no duplicate line ids
      seenLineIds[lineId] = 1;
      if (String(ln.allocation_draft_id || '').trim() !== id) { lineErr = 'FK_MISMATCH:' + lineId; break; }     // (4) FK integrity
      var lnSt = String(ln.line_status || '').trim().toLowerCase();
      if (lnSt === 'cancelled' || lnSt === 'expired') continue;                                                 // (8) non-cancelled, non-expired only
      var nat = [id, String(ln.sku || '').trim().toLowerCase(), String(ln.site_sku || '').trim().toLowerCase(), String(ln.window_code || '').trim().toLowerCase()].join('|');
      if (natKeys[nat]) { lineErr = 'DUPLICATE_NATURAL_KEY:' + nat; break; }                                    // (6) no duplicate natural keys
      natKeys[nat] = 1;
      var qty = Number(String(ln.planned_qty == null ? '' : ln.planned_qty).trim());
      if (!isFinite(qty) || qty <= 0) continue;                                                                 // (7) positive qty (0 → not shipped)
      shippable.push(ln);
    }
    if (lineErr) { errors.push({ allocation_draft_id: id, reason: lineErr }); return; }
    if (!shippable.length) { errors.push({ allocation_draft_id: id, reason: 'NO_POSITIVE_PLANNED_QTY_LINES' }); return; }
    drafts.push({ id: id, header: header, lines: shippable });
    if (isSubmitted) alreadySubmitted.push(id); else toTransition.push(id);
  });
  // F1-7N-FB-3C §I — the ONE station this submit commits, taken from the PERSISTED headers (never the payload).
  // It is captured during the station gate below and reused by the post-commit output verification.
  var sadAppliedStation = null;
  // ---- (14)/(15) F1-7N-FB-3B §G — SERVER-SIDE STATION SCOPE. Site Inventory Submit Plan is scoped to EXACTLY the
  // currently APPLIED Country + Marketplace, and until now that was enforced only by the browser choosing which
  // draft ids to send. A page bug, a stale selector, a replayed payload or a hand-crafted request could therefore
  // submit drafts belonging to two different stations inside ONE Weekly Shipping Plan batch. Two independent gates
  // close it, both FAIL CLOSED and both before any write:
  //   (14) MIXED_SITE_PAYLOAD  — the requested drafts do not all belong to ONE company+country+marketplace. This
  //        holds even when the caller sends no applied_scope, so an unversioned client still cannot mix stations.
  //   (15) APPLIED_SCOPE_MISMATCH — when the caller declares its APPLIED station (applied_scope), every draft must
  //        belong to exactly that station. A stale selector is then a named refusal rather than a silent write to
  //        whichever station the drafts happened to carry.
  // Scope identity comes from the PERSISTED header (never from the request body), so the payload cannot assert a
  // station it does not own. Site Inventory is deliberately different from Request Order Send here: Submit Plan is
  // a single-station commitment, while Send Request is comprehensive across stations by frozen business rule.
  if (!errors.length && drafts.length) {
    var sadStationOf_ = function (h) {
      return [String(h.company == null ? '' : h.company).trim().toUpperCase(),
              String(h.country == null ? '' : h.country).trim().toUpperCase(),
              String(h.marketplace == null ? '' : h.marketplace).trim().toLowerCase()].join('|');
    };
    var stations = {}, stationList = [];
    drafts.forEach(function (d) { var s = sadStationOf_(d.header); if (!stations[s]) { stations[s] = 1; stationList.push(s); } });
    if (stationList.length > 1) {
      return { success: false, error: 'MIXED_SITE_PAYLOAD — the requested Execution Plan drafts belong to ' + stationList.length +
        ' different Country/Marketplace stations. Submit Plan commits ONE station at a time; nothing was written.',
        code: 'MIXED_SITE_PAYLOAD', stage: 'validation', zero_write: true,
        data: { execution_key: execKey, station_count: stationList.length,
          stations: drafts.map(function (d) { return { allocation_draft_id: d.id, company: String(d.header.company || ''), country: String(d.header.country || ''), marketplace: String(d.header.marketplace || '') }; }).slice(0, 25) } };
    }
    sadAppliedStation = { company: String(drafts[0].header.company || ''), country: String(drafts[0].header.country || ''), marketplace: String(drafts[0].header.marketplace || '') };
    var appliedScope = body.applied_scope || null;
    if (appliedScope) {
      var want = sadStationOf_(appliedScope);
      if (want !== '||' && want !== stationList[0]) {
        return { success: false, error: 'APPLIED_SCOPE_MISMATCH — the drafts belong to a different Country/Marketplace than the applied selection. The selector is stale; re-apply Search and Submit again. Nothing was written.',
          code: 'APPLIED_SCOPE_MISMATCH', stage: 'validation', zero_write: true,
          data: { execution_key: execKey,
            applied: { company: String(appliedScope.company || ''), country: String(appliedScope.country || ''), marketplace: String(appliedScope.marketplace || '') },
            drafts_station: { company: String(drafts[0].header.company || ''), country: String(drafts[0].header.country || ''), marketplace: String(drafts[0].header.marketplace || '') } } };
      }
    }
  }
  if (errors.length) return { success: false, error: 'SUBMIT_VALIDATION_FAILED', code: 'SUBMIT_VALIDATION_FAILED', stage: 'validation', zero_write: true, data: { execution_key: execKey, errors: errors.slice(0, 25) } };

  // already-submitted drafts may only be replayed as an IDEMPOTENT reuse of the SAME execution-key plan; a new key over
  // already-submitted drafts is a CONFLICT (no double submit). (13) no already-submitted conflicting lineage.
  // read-only shipping_plans lookup (never ENSURE here — the shipping_plans WRITE authority lives in 11_).
  if (alreadySubmitted.length) {
    var planSheet0 = ss.getSheetByName('shipping_plans');
    var keyPlans0 = planSheet0 ? shippingPlanReadObjects_(planSheet0).filter(function (p) { return String(p.submit_batch_id || '').trim() === execKey; }) : [];
    if (!keyPlans0.length) return { success: false, error: 'SUBMIT_DRAFT_ALREADY_SUBMITTED', code: 'CONFLICT', stage: 'validation', zero_write: true, data: { execution_key: execKey, already_submitted: alreadySubmitted } };
  }

  // ---- DERIVE the normalized shipping-plan lines[] from ALL persisted drafts (server-owned; stable fingerprint) ---
  // F1-7N-FB-4G-A2 §9 — THE WRITER THAT TURNS A DRAFT INTO A DURABLE WEEKLY SHIPPING PLAN DID NOT READ THE
  // CANONICAL DESTINATION AT ALL. Measured by executing this derivation over the four live header shapes:
  //
  //   header dest_marketplace  dest_wh_id     code_snapshot   scope marketplace |  plan destination   type
  //   'Amazon'                 ''             ''              'Amazon'          |  'Amazon'           marketplace
  //   'Amazon'                 ''             ''              'Walmart'         |  'WALMART'  <-- (1) marketplace
  //   ''                       ''             'Amazon'        'Amazon'          |  'Amazon'   <-- (2) marketplace
  //   ''                       'WH-US-3PL-01' 'US3PL01'       'Amazon'          |  'US3PL01'          warehouse
  //
  // The old line was `snapshot || destWhId || h.marketplace` — a truthy chain over three columns that do not
  // mean the same thing, and `destination_marketplace` (the column A0-R1 added and A0-R2 made the SOLE
  // destination authority) was not among them.
  //
  // (1) The page-SCOPE marketplace became the ROUTE's destination. It is right only when the station's
  //     marketplace happens to equal the destination the operator chose; H4 is that coincidence. At any
  //     station where they differ it writes a durable plan to a destination nobody selected.
  // (2) The warehouse-code SNAPSHOT was FIRST, so a legacy row holding a marketplace NAME in a warehouse-code
  //     column supplied the identity. A0-R2 removed that snapshot from the completeness GATE; this is the same
  //     misuse surviving in the MAPPING.
  //
  // `destination` is a shipping-plan GROUPING dimension (11_ groups on company+country+ship_from+
  // source_warehouse_id+destination+destination_warehouse_id+shipping_method+last_mile_delivery+planning_cycle
  // and checksum-binds it), so a wrong value does not merely mislabel a row — it decides which plan a line
  // joins. For H4 the corrected value is byte-identical ('Amazon' either way), so H4's grouping, its
  // fingerprint and its plan identity are unchanged; only the cases that were wrong move.
  //
  // The identity comes from the ONE owner, sadDestinationIdentity_ (which delegates to 69_
  // ricDestinationIdentity_ when deployed). Gate (9) has already refused any header whose destination is
  // missing or ambiguous, so this cannot be reached with an unresolved identity — and if it somehow were, it
  // REFUSES rather than inventing one.
  var submitLines = [];
  var destErrors = [];
  drafts.forEach(function (d) {
    var h = d.header;
    var shipFrom = String(h.recommended_source_warehouse_code_snapshot || h.recommended_source_warehouse_id || '').trim();
    var sadDst = sadDestinationIdentity_(h);
    if (!sadDst.ok) { destErrors.push({ allocation_draft_id: d.id, reason: sadDst.code || 'ROUTE_DESTINATION_UNRESOLVED' }); return; }
    var destWhId = (sadDst.type === 'WAREHOUSE') ? String(sadDst.id || '').trim() : '';
    // A WAREHOUSE destination is displayed by its stored code when there is one (that is what the snapshot
    // column is for) and by its id otherwise. A MARKETPLACE destination is the route's OWN marketplace column —
    // never the station's, and never a snapshot.
    var destination = (sadDst.type === 'WAREHOUSE')
      ? String(h.recommended_destination_warehouse_code_snapshot || destWhId || '').trim()
      : String(h.destination_marketplace || '').trim();
    var lineageBase = 'allocation_draft:' + d.id + '|run:' + String(h.calculation_run_id || '').trim() + '|fv:' + String(h.formula_version || '').trim() + '|cyc:' + String(h.planning_cycle || '').trim();
    d.lines.forEach(function (ln) {
      submitLines.push({
        company: h.company, country: h.country, marketplace: h.marketplace,
        ship_from: shipFrom, source_warehouse_id: String(ln.source_warehouse_id || h.recommended_source_warehouse_id || '').trim(), ship_from_type: 'warehouse',
        // destination_type is DERIVED FROM THE IDENTITY, not from whether one column happened to be non-blank.
        destination: destination, destination_warehouse_id: destWhId,
        destination_type: (sadDst.type === 'WAREHOUSE') ? 'warehouse' : 'marketplace',
        shipping_method: h.recommended_shipping_method, last_mile_delivery: h.recommended_last_mile_delivery, carrier_id: '', customs_type: '',
        planning_cycle: String(h.planning_cycle || '').trim(),   // F1-7N-FA-4B2(A): a grouping dimension (also fingerprint-bound via source_reason cyc:)
        sku: ln.sku, site_sku: ln.site_sku, requested_qty: ln.planned_qty, units_per_carton: ln.units_per_carton,
        source_page: String(h.source_page || 'inventory_replenishment').trim(),
        source_reason: lineageBase + '|line:' + String(ln.allocation_draft_line_id || '').trim(),
        inventory_snapshot_date: String(h.source_data_as_of || '').trim()
      });
    });
  });

  // F1-7N-FB-4G-A2 §9 — a destination that cannot be resolved fails the WHOLE batch with zero writes. Gate (9)
  // makes this unreachable through the normal path; it exists so that a future caller of this core cannot reach
  // the plan writer with a fabricated destination.
  if (destErrors.length) {
    return { success: false, error: 'SUBMIT_VALIDATION_FAILED', code: 'SUBMIT_VALIDATION_FAILED', stage: 'validation',
      zero_write: true, data: { execution_key: execKey, errors: destErrors.slice(0, 25) } };
  }

  // G — capture the EXACT before-state of every draft this execution will transition (durable rollback evidence +
  // in-execution restore). Only the cells this execution writes are captured (status/audit/note + draft_version).
  var draftBefore = {};
  toTransition.forEach(function (id) {
    var d0 = drafts.filter(function (x) { return x.id === id; })[0], h0 = d0 ? d0.header : {};
    draftBefore[id] = { status: String(h0.status == null ? '' : h0.status), submitted_by: String(h0.submitted_by == null ? '' : h0.submitted_by), submitted_at: String(h0.submitted_at == null ? '' : h0.submitted_at), updated_by: String(h0.updated_by == null ? '' : h0.updated_by), updated_at: String(h0.updated_at == null ? '' : h0.updated_at), note: String(h0.note == null ? '' : h0.note), draft_version: String(h0.draft_version == null ? '' : h0.draft_version) };
  });

  // ---- WRITE via the SINGLE shipping_plans authority (idempotent + durable-journal + readback-verified inside the core).
  // journalExtra binds the affected draft ids + before-state into the writer's durable rollback evidence (phase 1).
  var commit = shippingPlanCommitFromLines_(ss, submitLines, { source: source, createdBy: submittedBy, providedKey: execKey,
    journalExtra: { affected_draft_ids: toTransition.slice(), draft_before: draftBefore } });
  if (!commit.success) { commit.data = commit.data || {}; commit.data.execution_key = execKey; commit.data.drafts_unsubmitted = toTransition.slice(); return commit; }   // downstream failed → drafts stay unsubmitted

  // ---- TRANSITION not-yet-submitted drafts → submitted (ONLY after durable plan commit) + readback ------
  var now = procurementTimestamp_();
  var planIds = ((commit.data && commit.data.plans) || []).map(function (p) { return typeof p === 'string' ? p : String(p.shipping_plan_id || '').trim(); }).filter(String);
  var planTag = planIds.join(',');
  toTransition.forEach(function (id) {
    var f = procurementFindRow_(hSh, 'allocation_draft_id', id); if (!f) return;
    var prevNote = String(sadRowToObject_(hSh, f.row).note || '').trim();
    function setCol(name, val) { var c = f.col(name); if (c !== -1) hSh.getRange(f.row, c + 1).setValue(val); }
    setCol('status', 'submitted'); setCol('submitted_by', submittedBy); setCol('submitted_at', now); setCol('updated_by', submittedBy); setCol('updated_at', now);
    var appended = '[SUBMITTED @' + now + ' → shipping_plan ' + (planTag || '(reused)') + ' · exec ' + execKey + ']';
    setCol('note', prevNote ? (prevNote + '\n' + appended) : appended);
  });
  SpreadsheetApp.flush();
  var unverified = [];
  toTransition.forEach(function (id) { var f = procurementFindRow_(hSh, 'allocation_draft_id', id); if (!f || String(sadRowToObject_(hSh, f.row).status || '').trim().toLowerCase() !== 'submitted') unverified.push(id); });
  if (unverified.length) {
    // G — POSTCHECK failure: restore ONLY the draft cells this execution changed, AND roll back the committed plan rows
    // (inserted-only, reverse-FK) so we never leave a submitted draft without a verified plan, nor a plan behind.
    toTransition.forEach(function (id) {
      var fr = procurementFindRow_(hSh, 'allocation_draft_id', id); if (!fr) return; var b = draftBefore[id] || {};
      function setCol2(name, val) { var c = fr.col(name); if (c !== -1) hSh.getRange(fr.row, c + 1).setValue(val); }
      ['status', 'submitted_by', 'submitted_at', 'updated_by', 'updated_at', 'note'].forEach(function (k) { setCol2(k, b[k] == null ? '' : b[k]); });
    });
    var planRb = shippingPlanRollbackBatch_(ss, execKey, planIds);
    SpreadsheetApp.flush();
    var restoreOk = true;
    toTransition.forEach(function (id) { var fr2 = procurementFindRow_(hSh, 'allocation_draft_id', id); if (fr2 && String(sadRowToObject_(hSh, fr2.row).status || '').trim().toLowerCase() === 'submitted') restoreOk = false; });
    var rolledOk = planRb.ok && restoreOk;
    return { success: false, error: rolledOk ? 'POSTCHECK_FAILED_ROLLED_BACK' : 'POSTCHECK_FAILED_ROLLBACK_UNVERIFIED', code: rolledOk ? 'POSTCHECK_FAILED_ROLLED_BACK' : 'POSTCHECK_FAILED_ROLLBACK_UNVERIFIED', stage: 'draft_transition', zero_write: rolledOk, data: { execution_key: execKey, outcome: commit.data.outcome, plans_rolled_back: planIds, unverified_drafts: unverified, plan_rollback: planRb, draft_restore_ok: restoreOk } };
  }

  // ---- F1-7N-FB-3C §I — EXACT OUTPUT VERIFICATION over the committed plan, after the draft transition is
  // read back. The drafts are already `submitted` at this point, which is why a failure here is reported as
  // COMMITTED_OUTPUT_UNVERIFIED rather than rolled back: reversing a durably committed plan on the strength of a
  // verification read would be a second, less-tested mutation. The operator gets the exact mismatch instead.
  var planIdsForVerify = planIds.slice();
  var sadVerify = { ok: true, failures: [], verified_lines: 0, verified_qty: 0, plans_checked: 0, skipped: false };
  try {
    var vPlanSheet = ss.getSheetByName('shipping_plans');
    var vLineSheet = ss.getSheetByName('shipping_plan_lines');
    if (!planIdsForVerify.length || !vPlanSheet || !vLineSheet) {
      sadVerify.skipped = true;
      sadVerify.reason = !planIdsForVerify.length ? 'REUSED_EXISTING_PLAN_NO_NEW_IDS' : 'PLAN_TABLES_UNREADABLE';
    } else {
      sadVerify = sadVerifyShippingPlanOutput_(submitLines, planIdsForVerify,
        shippingPlanReadObjects_(vPlanSheet), shippingPlanReadObjects_(vLineSheet), sadAppliedStation || {});
    }
  } catch (eVer) { sadVerify = { ok: true, failures: [], skipped: true, reason: 'VERIFICATION_READ_FAILED: ' + (eVer && eVer.message ? eVer.message : eVer) }; }
  if (sadVerify.skipped !== true && sadVerify.ok !== true) {
    return { success: false, error: 'SHIPPING_PLAN_OUTPUT_VERIFICATION_FAILED', code: 'SHIPPING_PLAN_OUTPUT_VERIFICATION_FAILED',
      stage: 'output_verification', zero_write: false,
      data: { execution_key: execKey, plans: planIds, failures: sadVerify.failures.slice(0, 25),
        verified_lines: sadVerify.verified_lines, expected_lines: submitLines.length,
        applied_station: sadAppliedStation,
        next_action: 'The Weekly Shipping Plan WAS committed and the drafts are submitted, but its lines do not match the frozen Execution Plan quantities field by field. Nothing was rolled back \u2014 reversing a durable plan on a verification read would be a second mutation. Review the named mismatches on the plan before approving it.' } };
  }
  return { success: true, data: { execution_key: execKey, outcome: commit.data.outcome, reused: !!commit.data.reused,
    output_verification: { verified: sadVerify.skipped ? null : sadVerify.ok, skipped: !!sadVerify.skipped,
      reason: sadVerify.reason || '', verified_lines: sadVerify.verified_lines || 0,
      verified_qty: sadVerify.verified_qty || 0, expected_lines: submitLines.length,
      applied_station: sadAppliedStation },
    plan_count: (commit.data.plan_count || planIds.length), line_count: (commit.data.line_count || submitLines.length), plans: planIds,
    submitted_drafts: toTransition.slice(), already_submitted: alreadySubmitted,
    lineage: drafts.map(function (d) { return { allocation_draft_id: d.id, calculation_run_id: String(d.header.calculation_run_id || '').trim(), formula_version: String(d.header.formula_version || '').trim(), calculated_at: String(d.header.calculated_at || '').trim(), source_data_as_of: String(d.header.source_data_as_of || '').trim(), planning_cycle: String(d.header.planning_cycle || '').trim() }; }) } };
}

// ============================================================
// C2-D2 — K3 Active-Draft resolver + targeted read-only readback + whole-Draft Cancel.
// The Submit → shipping_plans / shipping_plan_lines handoff is DEFERRED (HALT): the source-availability /
// L2 commitment authority is unresolved in source/spec, createShippingPlansBatch produces random-UUID (non
// deterministic) downstream IDs, and idempotent retry would require a NEW allocation_draft lineage column on
// shipping_plans (prohibited). See docs/planning/ALLOCATION_DRAFT_PHASE1_CONTRACT_FREEZE.md.
// ============================================================

// Centralized K3 Active-Draft resolver (single lookup rule for Save / Cancel / Readback). Active = status not
// submitted/cancelled matching the K3 scope (planning_cycle + company + country + marketplace + source_page) —
// NEVER draft_version, NEVER recommendation_group_no. Returns
//   { status:'NO_ACTIVE_DRAFT'|'ACTIVE_DRAFT_FOUND'|'BLOCKED_CONFLICT', id, row, conflictIds }.
function sadResolveActiveDraft_(sh, scope) {
  scope = scope || {};
  var want = {
    pc: String(scope.planning_cycle == null ? '' : scope.planning_cycle).trim(),
    co: String(scope.company == null ? '' : scope.company).trim(),
    cy: String(scope.country == null ? '' : scope.country).trim(),
    mk: String(scope.marketplace == null ? '' : scope.marketplace).trim(),
    sp: String(scope.source_page == null || scope.source_page === '' ? 'inventory_replenishment' : scope.source_page).trim()
  };
  var empty = { status: 'NO_ACTIVE_DRAFT', id: '', row: 0, conflictIds: [] };
  if (!want.pc) return empty;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return empty;
  var h = data[0].map(function (x) { return String(x).trim(); });
  var ci = { pc: h.indexOf('planning_cycle'), co: h.indexOf('company'), cy: h.indexOf('country'),
    mk: h.indexOf('marketplace'), sp: h.indexOf('source_page'), st: h.indexOf('status'), id: h.indexOf('allocation_draft_id') };
  var matches = [];
  for (var r = 1; r < data.length; r++) {
    var st = String(data[r][ci.st] == null ? '' : data[r][ci.st]).trim().toLowerCase();
    if (SAD_TERMINAL_STATUSES_[st]) continue;   // active = not terminal (submitted / cancelled / expired)
    if (String(data[r][ci.pc]).trim() === want.pc && String(data[r][ci.co]).trim() === want.co &&
        String(data[r][ci.cy]).trim() === want.cy && String(data[r][ci.mk]).trim() === want.mk &&
        String(data[r][ci.sp]).trim() === want.sp) {
      matches.push({ id: String(data[r][ci.id]).trim(), row: r + 1 });
    }
  }
  if (!matches.length) return empty;
  if (matches.length > 1) return { status: 'BLOCKED_CONFLICT', id: '', row: 0, conflictIds: matches.map(function (m) { return m.id; }) };
  return { status: 'ACTIVE_DRAFT_FOUND', id: matches[0].id, row: matches[0].row, conflictIds: [] };
}

// F1-7N-FA-3C-R6F2 — read ACTIVE (draft/site_confirmed/partially_submitted) header rows as objects (read-only) for
// K2 CREATE/REUSE/CONFLICT resolution.
function sadReadActiveHeaderRows_(sh) {
  var data = sh.getDataRange().getValues();
  if (!data || data.length < 2) return [];
  var headers = data[0].map(function (x) { return String(x).trim(); });
  var cStatus = headers.indexOf('status');
  var ACTIVE = { draft: 1, site_confirmed: 1, partially_submitted: 1 };
  var out = [];
  for (var r = 1; r < data.length; r++) {
    var st = cStatus !== -1 ? String(data[r][cStatus]).trim().toLowerCase() : '';
    if (!ACTIVE[st]) continue;
    var o = {}; for (var c = 0; c < headers.length; c++) if (headers[c]) o[headers[c]] = data[r][c];
    o.status = st;
    out.push(o);
  }
  return out;
}

// F1-7N-FA-3C-R6F2 — the SINGLE active-draft resolution used by BOTH generation (atomic endpoint) AND manual save.
// A COMPLETE route (From+To+Method present) resolves by the 10-dim K2 group key (route-level identity);
// a no-route scratchpad falls back to the landed K3 scope. Returns { status:'CREATE'|'REUSE'|'CONFLICT', id,
// conflictIds, k2:bool }. CREATE under K2 returns the DETERMINISTIC header id (SADH-K2-…); CREATE under K3 returns ''.
// F1-7N-FA-3C-R6F2A (A — NO NEW K3 WRITES): route-complete → K2 (CREATE deterministic id / REUSE / CONFLICT). A
// route-INCOMPLETE new Draft NEVER creates a K3 header: if it would match an EXISTING active K3 row, editing that
// legacy row is fail-closed with LEGACY_ROUTE_RECONCILIATION_REQUIRED (unless opts.allowLegacyReconcile — a separate,
// explicit, USER-owned migration); otherwise the new write is BLOCKed with ROUTE_INCOMPLETE_NEW_DRAFT. Legacy K3 rows
// may be READ (readback/cancel) but never become the identity of a new K2 write.
// Returns { status:'CREATE'|'REUSE'|'CONFLICT'|'BLOCK', reason?, id, conflictIds, k2:bool, legacyReconcile? }.
function sadResolveActiveDraftK2OrK3_(sh, header, opts) {
  header = header || {}; opts = opts || {};
  if (sadHeaderRouteIsComplete_(header)) {
    var activeRows = sadReadActiveHeaderRows_(sh);

    // ---- F1-7N-FB-4F-B3: K4, and ONLY when the column that carries its destination physically exists --------
    //
    // K2's ten dimensions carry no destination marketplace, so a marketplace route and a destination-less route
    // key IDENTICALLY - the identity half of the FB-4F refusal. K4 adds the derived destination type and a
    // canonical destination identity, so `to Amazon` and `to nowhere` finally differ, and so do `sea` and
    // `sea_express` after the service passes through the canonical resolver.
    //
    // THE ORDER OF THE THREE OUTCOMES IS THE WHOLE DESIGN:
    //   K4 match      -> REUSE that row under its OWN id. A replay of the same route is an UPDATE, never a
    //                    second header, and an adopted K2-generation row is never re-keyed.
    //   K4 contested  -> CONFLICT. Two active headers for one shipment group is a business decision, not
    //                    something a writer resolves by picking one.
    //   K4 unmatched  -> before creating anything, ask whether a row exists that K2 WOULD have claimed. If one
    //                    does, it is an existing row for a DIFFERENT K4 identity that K2 cannot tell apart -
    //                    the legacy row this whole round exists because of. Creating beside it would duplicate
    //                    the route; adopting it would migrate a legacy row in place. Both are forbidden, so it
    //                    is BLOCKED and left exactly as it is for a separately authorized reconciliation.
    if (opts.k4Ready === true) {
      var r4 = sadK4ResolveActiveDraft_(activeRows, header);
      if (r4.status === 'REUSE') return { status: 'REUSE', id: r4.allocation_draft_id, conflictIds: [], k2: true, k4: true };
      if (r4.status === 'BLOCKED_CONFLICT') return { status: 'CONFLICT', id: '', conflictIds: r4.conflictIds || [], k2: true, k4: true };
      // ONLY rows K4 CANNOT CLASSIFY are rivals here. A row that stores a resolvable destination has its own
      // K4 identity and already failed to match above, which makes it a DIFFERENT ROUTE - two marketplaces, or
      // sea against sea_express - and a different route is entitled to its own header. The row this guard is
      // for is the one that stores NO destination: K2 claims it because K2 has no destination dimension, and K4
      // cannot tell it apart from the route being saved. That row is the legacy case, and it is left alone.
      var legacyRivals = activeRows.filter(function (r) { return !ricDestinationIdentity_(r).ok; });
      var rivalK2 = sadK2ResolveActiveDraft_(legacyRivals, header);
      // F1-7N-FB-4F-B6 §G.3 - MORE THAN ONE ELIGIBLE CANDIDATE IS A DECISION, NOT A WRITE. Unchanged, and
      // deliberately checked BEFORE the adoption branch: no amount of user authority makes "which of these two
      // headers did you mean?" answerable by a resolver.
      if (rivalK2.status === 'BLOCKED_CONFLICT') {
        return { status: 'BLOCK', reason: 'K4_IDENTITY_RECONCILIATION_REQUIRED', id: (rivalK2.allocation_draft_id || ''),
          conflictIds: rivalK2.conflictIds || [], k2: true, k4: true };
      }
      if (rivalK2.status === 'REUSE') {
        // F1-7N-FB-4F-B6 §G.2 - SAFE LEGACY ADOPTION, AND EVERY CONDITION IS RE-CHECKED HERE.
        //
        // The row this resolves to is an ACTIVE header that K4 cannot classify (it stores no destination at all)
        // and that matches the request on every one of K2's ten dimensions - same planning cycle, company,
        // country, marketplace, source page, source warehouse, service, last-mile and group number. It differs
        // from the route being saved in exactly one way: it has no destination. That is the legacy row.
        //
        // B3 left this case BLOCKED because both available moves were wrong WITHOUT A HUMAN: creating beside it
        // duplicates the route, adopting it migrates a live row. What B6 adds is the human. `allowLegacyReconcile`
        // is the existing, USER-owned migration authority the atomic endpoint already accepts, and the client
        // only sends it after an explicit confirmation dialog naming From / To / Method / Qty and saying that an
        // EXISTING record will be updated.
        //
        // Two conditions are enforced right here rather than trusted to the caller:
        //   * the authority must be explicitly true - a missing or falsy flag still BLOCKS;
        //   * the request must actually CARRY a destination. Adopting a legacy row and writing another blank
        //     destination onto it would move the row's identity for no gain, which is worse than refusing.
        //
        // The stored id is returned UNCHANGED, so the header is updated in place: no re-key, no second header,
        // and every shipping_allocation_draft_lines row that points at it stays pointing at it.
        var wantDest = ricDestinationIdentity_(header);
        if (opts.allowLegacyReconcile === true && wantDest.ok) {
          return { status: 'REUSE', id: rivalK2.allocation_draft_id, conflictIds: [], k2: true, k4: true,
            legacyAdoption: true, adoptedDestinationType: wantDest.type };
        }
        return { status: 'BLOCK', reason: 'K4_IDENTITY_RECONCILIATION_REQUIRED', id: (rivalK2.allocation_draft_id || ''),
          conflictIds: rivalK2.conflictIds || [], k2: true, k4: true };
      }
      return { status: 'CREATE', id: r4.allocation_draft_id, conflictIds: [], k2: true, k4: true };
    }

    var r = sadK2ResolveActiveDraft_(activeRows, header);
    if (r.status === 'CREATE') return { status: 'CREATE', id: r.allocation_draft_id, conflictIds: [], k2: true };
    if (r.status === 'REUSE') return { status: 'REUSE', id: r.allocation_draft_id, conflictIds: [], k2: true };
    return { status: 'CONFLICT', id: '', conflictIds: r.conflictIds || [], k2: true };
  }
  var k3 = sadResolveActiveDraft_(sh, { planning_cycle: header.planning_cycle, company: header.company,
    country: header.country, marketplace: header.marketplace, source_page: header.source_page });
  if (k3.status === 'BLOCKED_CONFLICT') return { status: 'CONFLICT', id: '', conflictIds: k3.conflictIds || [], k2: false };
  if (k3.status === 'ACTIVE_DRAFT_FOUND') {
    if (opts.allowLegacyReconcile === true) return { status: 'REUSE', id: k3.id, conflictIds: [], k2: false, legacyReconcile: true };
    return { status: 'BLOCK', reason: 'LEGACY_ROUTE_RECONCILIATION_REQUIRED', id: k3.id, conflictIds: [], k2: false };
  }
  return { status: 'BLOCK', reason: 'ROUTE_INCOMPLETE_NEW_DRAFT', id: '', conflictIds: [], k2: false };
}

// F1-7N-FA-3C-R6F2A/R6F2G5 — guard for editing an EXISTING row (resolved by explicit id OR by the K2 group authority).
// A route-incomplete GENERIC/legacy row is fail-closed (LEGACY_ROUTE_RECONCILIATION_REQUIRED) unless allowReconcile.
// R6F2G5 fix: a GENUINE K2 shipment group uses a MARKETPLACE as its logical destination, so its persisted 30-col header
// legitimately carries a BLANK recommended_destination_warehouse_id (destination_marketplace is NOT a stored column).
// The generic From+To+Method completeness rule — which the persisted header can only satisfy via a warehouse id — must
// therefore NOT reclassify a marketplace-logical K2 row as a legacy collision (the exact defect that made a committed
// K2 REUSE return LEGACY_ROUTE_RECONCILIATION_REQUIRED with zero writes). Authority for "is this a real K2 group" is the
// row's stored id EQUALLING the deterministic hash of its OWN K2 group dims (sadK2DeterministicHeaderId_) — the K2
// grouping authority, NEVER the SADH-K2- prefix alone. A SADH-K2- row whose stored dims do NOT regenerate its id
// (impostor / route drift) is refused with a DISTINCT typed K2_ROUTE_RECONCILIATION_REQUIRED (never auto-healed or
// overwritten). Generic (non-SADH-K2-) rows keep the exact original legacy rule unchanged. Returns a typed reason
// string to BLOCK, or '' to proceed.
//
// F1-7N-FB-4A §D — THE COMPARISON WAS WRONG, AND IT BRICKED THE ROW IT WAS PROTECTING.
// R6F2G5 asked "does this row's STORED id still equal the hash of its OWN CURRENT dims?". That question has a
// false-positive the writer itself manufactures: the UPDATE branch of sadUpsertDraftHeaderCore_ is ALLOWED to
// change recommended_source_warehouse_id / recommended_destination_warehouse_id / recommended_shipping_method /
// recommended_last_mile_delivery / recommendation_group_no, and five of those are K2 GROUPING DIMENSIONS. The
// SADH-K2- id, however, is minted ONCE at CREATE and is never re-keyed (re-keying would orphan every
// shipping_allocation_draft_lines row that points at it). So the first legitimate route edit succeeds and
// silently leaves stored_id = H(dims BEFORE the edit) while the row now holds dims AFTER the edit — and from the
// SECOND edit onward this guard compares H(after) against H(before), refuses its own row as an impostor, and the
// route can NEVER be saved again. The AI-Plan generation path makes this the NORMAL case rather than an edge
// case: the bundled generation engine leaves four of the ten K2 dims BLANK (see the K2 contract note above), so
// an AI-generated header is keyed over blank route dims and the operator's first completed route in the
// Execution Plan is exactly the edit that drifts it.
//
// The row was never an impostor. It is the caller's own row, holding the caller's own dims, under a stale
// CREATE-time surrogate id. The correct question is SEMANTIC, not self-referential:
//     does this persisted row belong to the SAME K2 shipment group as the request now being written?
// That is strictly stronger against a real impostor (a row for a DIFFERENT group is still refused, on the
// group key rather than on a hash coincidence) and it stops refusing the one row the caller means.
//
// Accepting a stale id is safe ONLY while the group is uncontested. If another ACTIVE header already carries the
// request's group key, adopting this drifted row would create a SECOND header for one shipment group — so that
// case is reported as BLOCKED_CONFLICT (a business decision) instead of being written.
//
// Nothing here is auto-healed: the stale id is KEPT exactly as stored (no re-key, no overwrite, no cancel, no
// delete, no line-FK rewrite). The row is updated IN PLACE under its existing identity, which is what an edit of
// an existing Execution Plan route has always meant.
var SAD_K2_BASIS_ID_MATCHES_ = 'K2_ID_MATCHES_OWN_GROUP';
var SAD_K2_BASIS_STALE_ACCEPTED_ = 'K2_STALE_CREATE_TIME_ID_ACCEPTED_SAME_GROUP';
var SAD_K2_BASIS_DIFFERENT_GROUP_ = 'K2_ROW_BELONGS_TO_A_DIFFERENT_SHIPMENT_GROUP';
var SAD_K2_BASIS_NO_REQUEST_GROUP_ = 'K2_ID_DRIFTED_AND_NO_REQUEST_GROUP_SUPPLIED_TO_COMPARE';
var SAD_K2_BASIS_CONTESTED_ = 'K2_GROUP_ALREADY_OWNED_BY_ANOTHER_ACTIVE_HEADER';

// PURE decision (no sheet access) so the regression suite executes the real rule rather than a description of it.
// persistedRow = the header-shaped object actually stored; wantHeader = the incoming request header (or null when
// the caller has none); activeRows = the other ACTIVE header-shaped rows. Returns { reason, basis, conflictIds }.
function sadK2ReconcileDecision_(persistedRow, wantHeader, activeRows) {
  var o = persistedRow || {};
  var storedId = String(o.allocation_draft_id == null ? '' : o.allocation_draft_id).trim();
  if (sadK2DeterministicHeaderId_(o) === storedId) return { reason: '', basis: SAD_K2_BASIS_ID_MATCHES_, conflictIds: [] };
  if (!wantHeader) return { reason: 'K2_ROUTE_RECONCILIATION_REQUIRED', basis: SAD_K2_BASIS_NO_REQUEST_GROUP_, conflictIds: [] };
  var want = sadK2GroupKey_(wantHeader);
  if (sadK2GroupKey_(o) !== want) return { reason: 'K2_ROUTE_RECONCILIATION_REQUIRED', basis: SAD_K2_BASIS_DIFFERENT_GROUP_, conflictIds: [] };
  var rivals = [];
  (activeRows || []).forEach(function (r) {
    var rid = String((r && r.allocation_draft_id) == null ? '' : r.allocation_draft_id).trim();
    if (!rid || rid === storedId) return;
    if (sadK2GroupKey_(r) === want) rivals.push(rid);
  });
  if (rivals.length) return { reason: 'BLOCKED_CONFLICT', basis: SAD_K2_BASIS_CONTESTED_, conflictIds: rivals };
  return { reason: '', basis: SAD_K2_BASIS_STALE_ACCEPTED_, conflictIds: [] };
}

// `wantHeader` is OPTIONAL and additive: omitted, the K2 branch keeps the exact pre-FB-4A self-hash rule, so no
// existing caller changes behaviour by accident. The generic (non-SADH-K2-) legacy rule is UNCHANGED — a legacy
// row genuinely requires a USER migration and is never adopted here (see §D of the FB-4A record).
function sadLegacyReconcileReason_(sh, found, allowReconcile, wantHeader) {
  if (!found || allowReconcile === true) return '';
  var o = sadRowToObject_(sh, found.row);
  var storedId = String(o.allocation_draft_id == null ? '' : o.allocation_draft_id).trim();
  if (storedId.indexOf('SADH-K2-') === 0) {
    if (sadK2DeterministicHeaderId_(o) === storedId) return '';
    if (!wantHeader) return 'K2_ROUTE_RECONCILIATION_REQUIRED';
    return sadK2ReconcileDecision_(o, wantHeader, sadReadActiveHeaderRows_(sh)).reason;
  }
  return sadHeaderRouteIsComplete_(o) ? '' : 'LEGACY_ROUTE_RECONCILIATION_REQUIRED';
}

// R6F2G5 — reason-typed reconciliation message for the two BLOCK call sites (atomic + manual). Keeps the outcome
// observable and distinct: a genuine legacy incomplete-route collision vs a K2 shipment-group identity mismatch.
// F1-7N-FB-4F-B3 - the resolver's BLOCK reasons, each said in its own words. The atomic core used to choose
// between exactly two sentences with an inline ternary, so a third reason would have been described as the
// second one - a new failure wearing an old failure's explanation.
function sadResolveBlockMessage_(reason) {
  if (reason === 'ROUTE_INCOMPLETE_NEW_DRAFT') {
    return 'a new Draft requires a COMPLETE route (From+To+Method); no K3 header is created for a missing route';
  }
  if (reason === 'K4_IDENTITY_RECONCILIATION_REQUIRED') {
    return 'an existing active Draft claims this route under the OLDER K2 identity, which cannot tell this ' +
      'destination apart from a blank one; creating beside it would duplicate the route and adopting it would ' +
      'migrate a legacy row in place, so it is left exactly as it is for a separately authorized reconciliation';
  }
  return 'this scope has an existing route-incomplete/legacy Draft — reconcile it via an explicit USER migration';
}

function sadReconcileMessage_(reason) {
  if (reason === 'BLOCKED_CONFLICT') {
    return 'this route\'s shipment group is already owned by a DIFFERENT active Draft header, so adopting this row would create a second header for one group; resolve the duplicate before saving';
  }
  if (reason === 'K2_ROUTE_RECONCILIATION_REQUIRED') {
    return 'this existing K2 Draft\'s stored id is not the deterministic hash of its own shipment-group route (K2 identity mismatch); reconcile via an explicit USER migration — never auto-healed or overwritten';
  }
  return 'this existing Draft has an incomplete route; reconcile via an explicit USER migration before editing';
}

// Read one sheet row (1-based) into a header-keyed object (read-only).
function sadRowToObject_(sh, rowNum) {
  var lastCol = sh.getLastColumn();
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (x) { return String(x).trim(); });
  var row = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
  var o = {};
  for (var i = 0; i < hdr.length; i++) if (hdr[i]) o[hdr[i]] = row[i];
  return o;
}

// Read the non-cancelled lines for one Draft id (read-only join by allocation_draft_id).
function sadReadLinesForDraft_(lsh, draftId) {
  var data = lsh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0].map(function (x) { return String(x).trim(); });
  var di = hdr.indexOf('allocation_draft_id'), si = hdr.indexOf('line_status');
  var out = [];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][di]).trim() !== draftId) continue;
    var lst_ = si !== -1 ? String(data[r][si] == null ? '' : data[r][si]).trim().toLowerCase() : '';
    if (lst_ === 'cancelled' || lst_ === 'expired') continue;   // FB-4C: expired lines are audit history, never active
    var o = {};
    for (var c = 0; c < hdr.length; c++) if (hdr[c]) o[hdr[c]] = data[r][c];
    out.push(o);
  }
  return out;
}

// C2-D2 §9: targeted READ-ONLY Allocation-Draft readback. Reads ONLY shipping_allocation_drafts +
// shipping_allocation_draft_lines (never getOperationDb). Body: { planning_cycle, company, country, marketplace,
// source_page }. Returns { success, data:{ status, draft, lines, issues }, errors }.
// F1-7N-FB-4B-ADDENDUM §D.10/§E — MULTI-SHIPMENT-GROUP READBACK.
//
// THE OLD RULE CONTRADICTED THE K2 CONTRACT IT WAS SERVING. This readback resolved through the K3 SCOPE
// (planning_cycle + company + country + marketplace + source_page) and declared BLOCKED_CONFLICT the moment that
// scope held more than one active header. But under the frozen K2 contract a header IS one shipment group, and one
// station legitimately holds SEVERAL shipment groups — that is precisely what `+ Add Route` creates. So the read
// path called the correct multi-route state a conflict, returned draft:null and lines:[], and made the very plan
// the writer had just persisted unreadable: hydrate lost the second route and the pre-submit quantity verification
// degraded to UNVERIFIABLE.
//
// THE CONFLICT TEST IS NOW THE GROUP KEY, NOT THE COUNT. Two active headers are a conflict when they claim the SAME
// canonical K2 group key — two headers for ONE shipment group, which is exactly what sadK2ResolveActiveDraft_ has
// always refused. Distinct group keys are distinct shipment groups and are returned together. Two legacy K3 rows
// both carry blank route dims, so they still share one group key and STILL report BLOCKED_CONFLICT — the legacy
// behaviour is preserved exactly rather than loosened.
//
// BACK-COMPAT IS EXACT. With one active header the response is byte-for-byte what it was: ACTIVE_DRAFT_FOUND +
// draft + lines. With several, `draft` is deliberately NULL — naming one header as "the" draft would misreport a
// two-route plan as a one-route plan — and the new `drafts` array carries every header with its own lines.
//
// §E — DUPLICATE CORRUPTION IS DISCLOSED, NEVER SMOOTHED OVER. Any allocation_draft_line_id appearing on more than
// one physical row is reported in duplicate_line_identities. The reader must not silently sum such rows (the three
// live 800-unit rows would read as 2400), and Submit must fail closed on them until the cleanup is run. Read-only.
function handleGetShippingAllocationDraftWorkspace_(body) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = procurementEnsureSheet_(ss, 'shipping_allocation_drafts', SHIPPING_ALLOCATION_DRAFTS_HEADERS_);
    var scope = {
      planning_cycle: String((body && body.planning_cycle) == null ? '' : body.planning_cycle).trim(),
      company: String((body && body.company) == null ? '' : body.company).trim(),
      country: String((body && body.country) == null ? '' : body.country).trim(),
      marketplace: String((body && body.marketplace) == null ? '' : body.marketplace).trim(),
      source_page: String((body && body.source_page) == null || body.source_page === '' ? 'inventory_replenishment' : body.source_page).trim()
    };
    var data = sh.getDataRange().getValues();
    if (!data || data.length < 2) return jsonResponse_({ success: true, data: { status: 'NO_ACTIVE_DRAFT', draft: null, lines: [], drafts: [], draft_count: 0, duplicate_line_identities: [], issues: [] }, errors: [] });
    var hdr = data[0].map(function (x) { return String(x).trim(); });
    function ci(n) { return hdr.indexOf(n); }
    var cPc = ci('planning_cycle'), cCo = ci('company'), cCy = ci('country'), cMk = ci('marketplace'),
      cSp = ci('source_page'), cSt = ci('status');
    function cell(r, c) { return c === -1 ? '' : String(data[r][c] == null ? '' : data[r][c]).trim(); }

    var matched = [];
    for (var r = 1; r < data.length; r++) {
      var st = cell(r, cSt).toLowerCase();
      if (SAD_TERMINAL_STATUSES_[st]) continue;      // active = not terminal (submitted / cancelled / expired)
      if (scope.planning_cycle && cell(r, cPc) !== scope.planning_cycle) continue;
      if (cell(r, cCo) !== scope.company) continue;
      if (cell(r, cCy) !== scope.country) continue;
      if (cell(r, cMk) !== scope.marketplace) continue;
      if (cell(r, cSp) !== scope.source_page) continue;
      matched.push(sadRowToObject_(sh, r + 1));
    }
    if (!matched.length) return jsonResponse_({ success: true, data: { status: 'NO_ACTIVE_DRAFT', draft: null, lines: [], drafts: [], draft_count: 0, duplicate_line_identities: [], issues: [] }, errors: [] });

    // CONFLICT = two headers claiming ONE shipment group (the K2 rule), never merely "more than one header".
    var byGroup = {}, groupOrder = [];
    matched.forEach(function (o) {
      var k = sadK2GroupKey_(o);
      if (!byGroup[k]) { byGroup[k] = []; groupOrder.push(k); }
      byGroup[k].push(o);
    });
    var contested = [];
    groupOrder.forEach(function (k) {
      if (byGroup[k].length > 1) {
        byGroup[k].forEach(function (o) { contested.push(String(o.allocation_draft_id == null ? '' : o.allocation_draft_id).trim()); });
      }
    });
    if (contested.length) {
      return jsonResponse_({ success: true, data: { status: 'BLOCKED_CONFLICT', draft: null, lines: [], drafts: [], draft_count: 0,
        duplicate_line_identities: [], issues: [{ code: 'BLOCKED_CONFLICT', conflictIds: contested }] }, errors: [] });
    }

    var lsh = procurementEnsureSheet_(ss, 'shipping_allocation_draft_lines', SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_);
    var allLines = [], drafts = [], dupes = [], issues = [];
    matched.forEach(function (o) {
      var id = String(o.allocation_draft_id == null ? '' : o.allocation_draft_id).trim();
      var ls = sadReadLinesForDraft_(lsh, id);
      // §E — every primary key that names more than one physical row, named explicitly.
      var pk = {};
      ls.forEach(function (l) {
        var k = String(l.allocation_draft_line_id == null ? '' : l.allocation_draft_line_id).trim();
        if (!k) return;
        var lst = String(l.line_status == null ? '' : l.line_status).trim().toLowerCase();
        if (lst === 'cancelled' || lst === 'expired') return;   // FB-4C: an expired line is audit, never active
        (pk[k] = pk[k] || []).push(l);
      });
      Object.keys(pk).forEach(function (k) {
        if (pk[k].length <= 1) return;
        dupes.push({ allocation_draft_id: id, allocation_draft_line_id: k, physical_rows: pk[k].length,
          sku: String(pk[k][0].sku == null ? '' : pk[k][0].sku),
          planned_qty_values: pk[k].map(function (x) { return String(x.planned_qty == null ? '' : x.planned_qty); }) });
      });
      if (id.indexOf('SADH-K2-') !== 0) issues.push({ code: 'LEGACY_HEADER_PRESENT_IN_SCOPE', allocation_draft_id: id });
      drafts.push({ draft: o, lines: ls, allocation_draft_id: id, k2_group_key: sadK2GroupKey_(o) });
      allLines = allLines.concat(ls);
    });
    if (dupes.length) issues.push({ code: 'DUPLICATE_LINE_IDENTITY_PERSISTED', count: dupes.length });

    if (matched.length === 1) {
      // EXACT back-compat for the single-shipment-group case.
      return jsonResponse_({ success: true, data: { status: 'ACTIVE_DRAFT_FOUND', draft: drafts[0].draft, lines: drafts[0].lines,
        drafts: drafts, draft_count: 1, duplicate_line_identities: dupes, issues: issues }, errors: [] });
    }
    return jsonResponse_({ success: true, data: { status: 'ACTIVE_DRAFT_GROUP_FOUND', draft: null, lines: allLines,
      drafts: drafts, draft_count: drafts.length, duplicate_line_identities: dupes, issues: issues }, errors: [] });
  } catch (e) {
    return jsonResponse_({ success: false, data: null, errors: [{ code: 'READBACK_ERROR', message: String(e && e.message ? e.message : e) }] });
  }
}

// C2-D2 §13: whole-Draft Cancel. Resolves the exact Draft (explicit id, else K3), soft-cancels the header
// (status + cancelled_* audit), PRESERVES header + lines, idempotent (repeat → benign ALREADY_CANCELLED). A
// submitted Draft is NOT cancelled (SC-1 not inferred). Under ScriptLock.
function handleCancelShippingAllocationDraft_(body) {
  var lock = LockService.getScriptLock();
  try { if (!lock.tryLock(30000)) return jsonResponse_({ success: false, error: 'Could not acquire lock; please retry.', stage: 'lock' }); }
  catch (e) { return jsonResponse_({ success: false, error: 'Lock error: ' + (e && e.message ? e.message : e), stage: 'lock' }); }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = procurementEnsureSheet_(ss, 'shipping_allocation_drafts', SHIPPING_ALLOCATION_DRAFTS_HEADERS_);
    var id = String((body && body.allocation_draft_id) || '').trim();
    var found = id ? procurementFindRow_(sh, 'allocation_draft_id', id) : null;
    if (!id) {
      var k3 = sadResolveActiveDraft_(sh, { planning_cycle: (body && body.planning_cycle), company: (body && body.company),
        country: (body && body.country), marketplace: (body && body.marketplace), source_page: (body && body.source_page) });
      if (k3.status === 'BLOCKED_CONFLICT') return jsonResponse_({ success: false, error: 'BLOCKED_CONFLICT', data: { status: 'BLOCKED_CONFLICT', conflictIds: k3.conflictIds } });
      if (k3.status === 'NO_ACTIVE_DRAFT') return jsonResponse_({ success: false, error: 'NO_ACTIVE_DRAFT' });
      id = k3.id; found = procurementFindRow_(sh, 'allocation_draft_id', id);
    }
    if (!found) return jsonResponse_({ success: false, error: 'NO_ACTIVE_DRAFT' });
    function get(name) { var c = found.col(name); return c !== -1 ? String(sh.getRange(found.row, c + 1).getValue()).trim() : ''; }
    function setCol(name, val) { var c = found.col(name); if (c !== -1) sh.getRange(found.row, c + 1).setValue(val); }
    var st = get('status').toLowerCase();
    if (st === 'cancelled') return jsonResponse_({ success: true, data: { allocation_draft_id: id, status: 'cancelled', already_cancelled: true } });
    if (st === 'submitted') return jsonResponse_({ success: false, error: 'IMMUTABLE_TERMINAL_STATUS:submitted' });
    var now = procurementTimestamp_();
    var actor = String((body && body.cancelled_by) || (body && body.actor) || 'inventory-replenishment').trim();
    setCol('status', 'cancelled'); setCol('cancelled_by', actor); setCol('cancelled_at', now);
    setCol('cancel_reason', String((body && body.cancel_reason) || '').trim());
    setCol('updated_by', actor); setCol('updated_at', now);
    return jsonResponse_({ success: true, data: { allocation_draft_id: id, status: 'cancelled', already_cancelled: false } });
  } finally { try { lock.releaseLock(); } catch (e2) { /* best-effort release */ } }
}
