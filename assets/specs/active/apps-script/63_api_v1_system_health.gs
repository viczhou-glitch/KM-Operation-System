// ============================================================
// Kitchen Mama Operation System — Apps Script (modularized source mirror)
// 63_api_v1_system_health.gs — F1-7N-FB-2 §D/§K read-only production health + flow readiness
// NOTE: All .gs files in this folder share ONE global scope. Copy them into the project TOGETHER.
// ------------------------------------------------------------
// WHY THIS EXISTS. The production failure this closes was undiagnosable from the browser: a POST to the Web App
// returned "HTTP 404, text/html", and there was no way to tell whether the deployment was unreachable, the
// deployed code was a partial sync missing a router action, the DB headers had drifted, or the transport simply
// flaked. Note what the router already guarantees: BOTH doGet and doPost return jsonResponse_ on every path,
// including the unknown-action and top-level-catch paths — so a 404 text/html body can NEVER be produced by this
// script. It comes from upstream of the router (deployment not resolving, an access/redirect page, or the
// POST -> googleusercontent echo hop). `system.health` is the probe that tells those apart.
//
// STRICTLY READ-ONLY and deliberately NON-SENSITIVE. It returns operational facts only: no spreadsheet id, no
// Drive id, no token, no credential, no user identity, no row data, no header names beyond a present/ok flag.
// It performs no write, takes no lock, and touches no Drive API.
// ============================================================

var SYS_API_CONTRACT_VERSION_ = '1';
// ------------------------------------------------------------------------------------------------------------
// F1-7N-FB-3A §C — DEPLOYMENT IDENTITY. This is the field that failed us, and the failure was mine.
//
// The live evidence read `build=F1-7N-FB-2` while the editor could already run the FB-3 registry successfully.
// That looked like a stale deployment, but it was not diagnostic of anything: FB-3 added 64_/65_ and new router
// branches and NEVER BUMPED THIS CONSTANT. So the one field whose entire purpose is "prove which code
// answered" could not distinguish FB-2 from FB-3 at all.
//
// Worse, `missing_actions=[]` is SELF-REFERENTIAL: it is computed from the DEPLOYED code's own
// SYS_REQUIRED_ACTIONS_ list. A deployment that predates an action cannot know the action exists, so it
// reports "nothing missing" while genuinely missing it. An empty missing_actions is therefore NOT evidence
// that a deployment is complete — only the version fields below can establish that, by being compared against
// what the FRONTEND expects.
//
// Rules for these constants:
//   • SYS_DEPLOYMENT_RELEASE_ MUST be bumped in the same commit as any sync-visible backend change.
//   • SYS_BUILD_VERSION_ MUST be bumped in the same commit as any change to THIS FILE.
//   • SYS_DEPLOYED_ACTION_CONTRACT_VERSION_ MUST be bumped whenever a router ACTION is added or removed.
//   • SYS_REQUIRED_ACTION_LIST_VERSION_ MUST be bumped whenever SYS_REQUIRED_ACTIONS_ changes.
// The frontend pins the versions it needs and refuses a mismatch with a NAMED error, never a generic one.
// ------------------------------------------------------------------------------------------------------------
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6 §4 — ONE CONSTANT WAS ANSWERING TWO QUESTIONS, AND IT ANSWERED THE WRONG ONE.
//
// THE LIVE OBSERVATION. After R6-R5 was deployed the operator read `identity.build_id = ...-R6-R2` beside
// `router_build = ...-R6-R5` and `SIR_BUILD_VERSION_ = ...-R6-R5`, with `mixed_deployment: false`. The
// reasonable conclusion — that R6-R5 had not been deployed — was wrong, and the field that produced it is the
// one whose entire purpose is to prove which code answered. That is the FB-3A defect recorded at the top of
// this file, recurring, and the recurrence is worth naming rather than quietly patching.
//
// WHY THE EXISTING GUARD DID NOT FIRE. There IS a standing check (R5 suite E4: no manifest owner may carry a
// stamp older than its own last change), and running it against a clean tree reports 63_ correctly. It was
// silent during R6-R5 for a timing reason: it SKIPS any file with uncommitted changes, on the reasoning that
// a dirty file is the round's own edit in progress. So it goes quiet during exactly the window in which the
// rule is broken, and by the time it would speak, the round has shipped. The check is repaired in the same
// change as the stamp, because a rule with a hole this shaped is how the omission happened at all.
//
// WHY THE MANIFEST COULD NOT SEE IT EITHER. 63_'s own entry in SYS_MODULE_BUILD_STAMPS_ compares
// SYS_BUILD_VERSION_ against a literal written a few lines above it in the SAME FILE. That comparison is
// tautological — it cannot fail, and it cannot detect anything — which is precisely the `missing_actions=[]`
// self-reference this file's header warns about, in a new place. It stays (a stale 63_ is caught first and by
// different evidence: its action-contract version is older than the frontend pins), but it is now DOCUMENTED
// as self-referential instead of being mistaken for coverage.
//
// THE SPLIT. Two different questions were sharing one answer:
//
//   • WHICH RELEASE is this deployment meant to be?  → SYS_DEPLOYMENT_RELEASE_. It moves whenever ANY
//     sync-visible backend file changes, which is what an operator means by "is R6-R5 deployed?".
//   • WHICH ROUND did THIS FILE last change?          → SYS_BUILD_VERSION_. It is 63_'s module stamp, the
//     same kind of fact every other owner file declares, and it must NOT be bumped to look current.
//
// Those two are equal today and will usually be equal, because a release that changes any server file
// normally touches this manifest too. They are still separate constants, because "usually equal" is not a
// contract and a round that changes only 60_ would silently make them differ.
//
// WHAT `mixed_deployment: false` STILL MEANS, UNCHANGED AND STILL HONEST. It is a PER-FILE claim: every
// probed owner declares the build its manifest entry expects. It was true during the live observation and it
// was not the misleading field. build_id says which release this deployment INTENDS to be; mixed_deployment
// says whether the files actually AGREE with that intention. Neither substitutes for the other, and a reader
// needs both — which is why the identity block below now names each build it can see, individually, instead
// of publishing one string and leaving the operator to guess its scope.
// ------------------------------------------------------------------------------------------------------------
// R6-R6-R4-R2 — THE RELEASE MOVES, because this round changes 16_ (an UPDATE that declares no
// expected_draft_version is now refused) and therefore REQUIRES a new Web App deployment version. The
// release says which release a deployment intends to be; leaving it behind would report a deployment
// carrying the new refusal as though it were the one that did not have it.
// R6-R7-R1 — THE RELEASE MOVES AGAIN, because this round changes 61_ (a valid zero recommendation is now
// a typed success rather than a REQUESTED_SCOPE_EMPTY refusal) and therefore REQUIRES a new Web App
// deployment version. A deployment still answering the old 61_ would keep reporting a correct finish as a
// failure, and the release id is what says which of those two a deployment is.
var SYS_DEPLOYMENT_RELEASE_ = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R1';
// 63_'s OWN module build stamp — the round in which THIS FILE last changed. Not the release; see above.
// R6-R6-R4-R2 — moved because 16_'s manifest row moved with 16_ itself. The RELEASE above is deliberately
// not marched to it: it says which release this deployment intends to be, and cutting one is the user's act.
var SYS_BUILD_VERSION_ = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R1';
// ------------------------------------------------------------------------------------------------------------
// F1-7N-FB-4E §H — THE SHARED-TRANSPORT CONTRACT IS A SEPARATE AXIS FROM THE ACTION CONTRACT.
//
// `deployed_action_contract_version` answers "does this deployment know the actions the pages call?". It cannot
// answer "does this deployment speak the transport dialect the frontend needs?" — and that is the axis this
// round added, because the typed method/handler/body facts the client's §L proof depends on are emitted by the
// ROUTER, not by any action. A deployment can know every action and still be unable to say which handler
// answered, and a frontend on a newer transport contract must be able to name THAT rather than report a
// mysterious classification gap.
//
// Bump this when the router's response IDENTITY fields change (handler / received_method / post_body_present /
// action_present_in_query / router_build). v1 = the FB-4E set.
// ------------------------------------------------------------------------------------------------------------
var SYS_TRANSPORT_CONTRACT_VERSION_ = 1;
// Incremented when the set of router actions changes. The frontend compares this against its own pinned
// minimum, so a deployment that predates an action it needs is rejected BY VERSION rather than discovered
// through a confusing per-action failure.
// F1-7N-FB-4E-R2: 7 -> 8. A router ACTION was added (system.executionPlanDuplicateLineDiagnostic), which is
// precisely the condition this constant's rule names. The frontend raises its pinned minimum to 8 in the same
// change, so a deployment that predates the new route is rejected BY VERSION rather than only by the per-action
// probe — two independent gates for the same fact, which is the point of having both.
// F1-7N-FB-4E-R3: 8 -> 9. overseasStock.workspace.get is a NEW router ACTION, which is exactly the condition
// this constant's rule names. The frontend raises its pinned minimum to 9 in the same change: an Overseas page
// that has been cut over to the workspace read CANNOT work against a deployment that does not route it, so the
// version gate must reject that deployment by version rather than let the page discover it as a failed read.
// F1-7N-FC-1A-R1: 10 -> 11. THE RULE FIRES HERE. This constant's rule is "bump whenever a router ACTION is
// added or removed", and R1 adds `cancelShipmentDraft`. It is not a formality in this round: FC-1A made
// Shipment Draft creation ACQUIRE a factory stock reservation, and until this action exists there is no routed
// way to release one before dispatch. A deployment carrying FC-1A without R1 can therefore strand units
// permanently, so it must be rejected BY VERSION at the browser's first contract check rather than discovered
// when an operator finds the Cancel button does nothing. The frontend raises its pinned minimum to 11 in the
// same commit.
var SYS_DEPLOYED_ACTION_CONTRACT_VERSION_ = 11;
// Incremented when SYS_REQUIRED_ACTIONS_ changes, so a caller can tell a "nothing missing" answer from an
// OLD list apart from a "nothing missing" answer from the CURRENT list.
// F1-7N-FB-4E-R2: 7 -> 8. SYS_REQUIRED_ACTIONS_ gained four entries, and the whole purpose of this number is
// to let a caller tell a "nothing missing" answer computed from an OLD list apart from one computed from the
// current list. Not bumping it would make the R2 registry indistinguishable from the R1 registry that omitted
// four actions — which is the exact failure this constant exists to prevent.
// F1-7N-FB-4E-R3: 8 -> 9. SYS_REQUIRED_ACTIONS_ gained overseasStock.workspace.get.
// F1-7N-FB-4G-A2-R3: 9 -> 10. SYS_REQUIRED_ACTIONS_ gained upsertShippingAllocationDraftAtomic.
//
// SYS_DEPLOYED_ACTION_CONTRACT_VERSION_ deliberately does NOT move. Its rule is "bump whenever a router ACTION
// is added or removed", and this round adds NO route: upsertShippingAllocationDraftAtomic has been in
// 01_router.gs since F1-7N-FA-3C-R6F1. Any deployment already at action-contract v10 therefore routes it, and
// the per-action handler probe is the second, independent gate for a partial file-by-file sync.
// SYS_TRANSPORT_CONTRACT_VERSION_ does not move either: the envelope shape is unchanged.
// F1-7N-FC-1A: 10 -> 11. SYS_REQUIRED_ACTIONS_ gained createShipmentFromPlan. The action itself has been
// routed since the Shipment Center work, so SYS_DEPLOYED_ACTION_CONTRACT_VERSION_ deliberately does NOT move
// (its rule is "bump when a router ACTION is added or removed"). What changed is that a PAGE now depends on
// it: the Weekly Shipping Plan card's Retry Shipment Draft is the recovery path for a committed approval whose
// Execution Commit failed, and a deployment missing it must be a named deployment fact rather than a Retry
// button that does nothing.
// F1-7N-FC-1A-R1: 11 -> 12. SYS_REQUIRED_ACTIONS_ gained cancelShipmentDraft.
var SYS_REQUIRED_ACTION_LIST_VERSION_ = 12;

// The router actions the affected pages depend on. A partial Apps Script sync is the one failure mode that
// looks like a transport fault from the browser, so availability is reported per action by probing the handler
// symbol in the shared global scope — never by calling it.
var SYS_REQUIRED_ACTIONS_ = [
  { action: 'weeklyShipping.workspace.get', handler: 'handleWeeklyShippingWorkspaceGet_', used_by: 'Weekly Shipping Plan' },
  { action: 'shipment.workspace.get', handler: 'handleShipmentWorkspaceGet_', used_by: 'Shipment Draft / Overview / Map' },
  { action: 'purchaseOrder.workspace.get', handler: 'handlePurchaseOrderWorkspaceGet_', used_by: 'Purchase Order Workspace' },
  { action: 'inventoryReplenishment.workspace.get', handler: 'handleInventoryReplenishmentWorkspaceGet_', used_by: 'Site Inventory' },
  // F1-7N-FB-3 §C/§G — the slim scope registry is now what Site Inventory's selectors depend on at mount, so a
  // partial sync that omits 64_ must be visible here rather than looking like a slow page.
  { action: 'inventoryScope.registry.get', handler: 'handleInventoryScopeRegistryGet_', used_by: 'Site Inventory scope selectors' },
  { action: 'system.shippingAllocationSchemaDiagnostic', handler: 'handleShippingAllocationSchemaDiagnostic_', used_by: 'Execution Plan schema diagnostic' },
  { action: 'system.requestOrderSendDiagnostic', handler: 'handleRequestOrderSendDiagnostic_', used_by: 'Send Request diagnostic' },
  { action: 'system.twoVerticalFlowsDiagnostic', handler: 'handleTwoVerticalFlowsDiagnostic_', used_by: 'Two-vertical flow diagnostic' },
  { action: 'system.requestOrderSendReconcile', handler: 'handleRequestOrderSendReconcile_', used_by: 'Interrupted Send Request reconciliation' },
  // F1-7N-FB-3B §E/§F — the Send Request SERVER ORCHESTRATION and its slim workset read (owner = 66_). These are
  // the two actions one Send click now depends on, so a partial sync that omits 66_ must be named here rather
  // than reaching the user as a Send that silently does nothing.
  { action: 'requestOrder.send.orchestrate', handler: 'handleRequestOrderSendOrchestrate_', used_by: 'Send Request (server orchestration)' },
  { action: 'requestOrder.sendWorkset.get', handler: 'handleRequestOrderSendWorksetGet_', used_by: 'Send Request (slim workset / confirmation counts)' },
  // F1-7N-FB-3C — the reload-resume status read, the user-edit draft-creation boundary, and the read-only
  // identity reconciliation. A partial sync that omits 15_/66_/67_ must be named here rather than reaching the
  // user as an edit that saves nothing or a Send that cannot resume.
  { action: 'requestOrder.send.status', handler: 'handleRequestOrderSendStatus_', used_by: 'Send Request (reload resume / progress)' },
  { action: 'requestOrder.allocationDraft.ensureAndEdit', handler: 'handleRequestOrderAllocationDraftEnsureAndEdit_', used_by: 'Order Allocation quantity edit (canonical draft create/update)' },
  { action: 'system.allocationDraftIdentityDiagnostic', handler: 'handleAllocationDraftIdentityDiagnostic_', used_by: 'Allocation-draft identity reconciliation (read-only)' },
  // Vertical B — Procurement. Send Request writes through these three, then the PO vertical continues.
  { action: 'upsertRequestOrderAllocationDraft', handler: 'handleUpsertRequestOrderAllocationDraft_', used_by: 'Send Request (allocation draft)' },
  { action: 'upsertRequestOrderAllocationDraftLines', handler: 'handleUpsertRequestOrderAllocationDraftLines_', used_by: 'Send Request (allocation lines)' },
  { action: 'submitRequestOrderAllocationDrafts', handler: 'handleSubmitRequestOrderAllocationDrafts_', used_by: 'Send Request (lifecycle advance)' },
  { action: 'createRequestOrderDraft', handler: 'handleCreateRequestOrderDraft_', used_by: 'Send Request (Request Order)' },
  { action: 'createPurchaseOrderFromRequest', handler: 'handleCreatePurchaseOrderFromRequest_', used_by: 'Request Order -> PO Draft' },
  { action: 'requestOrder.workspace.get', handler: 'handleRequestOrderWorkspaceGet_', used_by: 'Request Order Workspace' },
  // F1-7N-FB-2A §G — the Execution Plan write/read set. These are the actions the Site Inventory route save
  // depends on, and a partial sync of 16_ is indistinguishable from a transport fault without probing them.
  { action: 'upsertShippingAllocationDraft', handler: 'handleUpsertShippingAllocationDraft_', used_by: 'Execution Plan route save (header)' },
  { action: 'system.executionPlanConflictDiagnostic', handler: 'handleExecutionPlanConflictDiagnostic_', used_by: 'F1-7N-FB-4A §C read-only Execution Plan identity conflict diagnostic' },
  { action: 'system.requestOrderSendDiagnosticStatus', handler: 'handleRequestOrderSendDiagnosticStatus_', used_by: 'F1-7N-FB-4A addendum §G read-only Request Order Send diagnostic ownership + cycle resolution' },
  { action: 'upsertShippingAllocationDraftLines', handler: 'handleUpsertShippingAllocationDraftLines_', used_by: 'Execution Plan route save (lines)' },
  // F1-7N-FB-4G-A2-R3 §E — THE ATOMIC WRITER, WHICH THE EXECUTION PLAN NOW DEPENDS ON.
  //
  // It has been routed since F1-7N-FA-3C-R6F1 but was never in this registry, so a deployment missing it could
  // only be discovered by a save failing. A2-R3 makes it the ONE path that creates or edits a route ticket
  // (header + line together or not at all), and the client fails closed rather than falling back to the
  // two-call writer — so its absence must be a named deployment fact before any save is attempted.
  { action: 'upsertShippingAllocationDraftAtomic', handler: 'handleUpsertShippingAllocationDraftAtomic_', used_by: 'Execution Plan route CREATE/UPDATE (atomic header + line)' },
  { action: 'getShippingAllocationDraftWorkspace', handler: 'handleGetShippingAllocationDraftWorkspace_', used_by: 'Execution Plan persisted readback' },
  { action: 'cancelShippingAllocationDraft', handler: 'handleCancelShippingAllocationDraft_', used_by: 'Execution Plan draft cancel' },
  { action: 'system.shippingAllocationDraftDiagnostic', handler: 'handleShippingAllocationDraftDiagnostic_', used_by: 'Execution Plan save diagnostic' },
  { action: 'submitAllocationDraftsToShippingPlans', handler: 'handleSubmitAllocationDraftsToShippingPlans_', used_by: 'Site Inventory Submit Plan' },
  { action: 'confirmShipmentAndDispatch', handler: 'handleConfirmShipmentAndDispatch_', used_by: 'Confirm Shipment' },
  // F1-7N-FC-1A §C/§J — THE SHIPMENT DRAFT RECOVERY ACTION.
  //
  // The FC-0A audit measured this as router + handler + adapter with NO caller anywhere in the frontend, while
  // the Approve failure message had been promising "You can retry from Shipment Overview" for rounds -- a
  // promise nothing could keep, on a page that renders `shipped` onward and so could never show the state
  // needing recovery. It is now called by the Approved plan card, which makes its absence from a deployment a
  // user-visible break and therefore something this registry must name.
  { action: 'createShipmentFromPlan', handler: 'handleCreateShipmentFromPlan_', used_by: 'Weekly Shipping Plan -- Retry Shipment Draft (approval recovery)' },
  // F1-7N-FC-1A-R1 §D — THE ONLY ROUTED WAY TO RELEASE A RESERVATION BEFORE DISPATCH.
  //
  // FC-1A made Shipment Draft creation acquire a reservation and shipped with no cancellation trigger, so a
  // reservation could become operationally unreleasable. A deployment missing this action does not merely lose
  // a button: it loses the ability to give units back, and the symptom is shipments refused for stock that is
  // physically present. That has to be a named deployment fact.
  { action: 'cancelShipmentDraft', handler: 'handleCancelShipmentDraft_', used_by: 'Shipment Draft -- Cancel Shipment Draft (releases the factory stock reservation)' },
  { action: 'updatePurchaseOrderStatus', handler: 'handleUpdatePurchaseOrderStatus_', used_by: 'Send PO' },
  { action: 'document.list', handler: 'handleEntityDocumentList_', used_by: 'Document Panels' },
  { action: 'document.retry', handler: 'handleDocumentRetry_', used_by: 'Document retry' },
  { action: 'document.diagnostic.purchaseOrder', handler: 'handlePoDocumentDiagnostic_', used_by: 'PO diagnostic' },
  { action: 'document.diagnostic.shipment', handler: 'handleShipmentDocumentDiagnostic_', used_by: 'Shipment diagnostic' },
  { action: 'finalizeShipmentFinalOutput', handler: 'handleFinalizeShipmentFinalOutput_', used_by: 'Shipment snapshot' },
  // F1-7N-FB-4E-R2 §2 — FOUR ACTIONS THE FRONTEND REQUIRES THAT THIS LIST DID NOT NAME.
  //
  // sysProbeRequested_ resolves a caller-named action ONLY through this table. So an action that is routed, has
  // a defined handler and is served correctly still came back `known_to_this_build: false` — and the
  // deployment-contract probe reported it MISSING from a deployment that was in fact serving it. Three of the
  // four below were exactly that: a registry omission reported as a stale deployment, which sends an operator
  // to re-publish something that was never wrong. The list is part of how this deployment describes itself, and
  // a self-description that omits what it serves is a defect in the same family as one that overstates it.
  //
  // The first three were routed all along (31_ and 59_); only their registry rows were missing. The fourth was
  // genuinely unreachable until R2 added its router branch — see 01_router.gs and 68_.
  { action: 'shipment.eta.update', handler: 'handleUpdateShipmentEta_', used_by: 'Shipment Map ETA edit (bounded eta-only writer; owner = 31_)' },
  { action: 'shipment.route.advance', handler: 'handleAdvanceShipmentRoutePoint_', used_by: 'Shipment Map route-point advance (owner = 31_)' },
  { action: 'skuDetails.workspace.get', handler: 'handleSkuDetailsWorkspaceGet_', used_by: 'SKU Details / SKU Regional Details scoped read (owner = 59_)' },
  { action: 'system.executionPlanDuplicateLineDiagnostic', handler: 'handleExecutionPlanDuplicateLineDiagnostic_', used_by: 'F1-7N-FB-4E-R2 §3 read-only Execution Plan duplicate-line diagnostic (owner = 68_)' },
  // F1-7N-FB-4E-R3 §C — the Overseas Stock scoped read. Registered in the SAME change that routes it, because
  // R2 exists precisely because an action was routed without being registered and the probe then reported a
  // deployment missing something it was serving.
  { action: 'overseasStock.workspace.get', handler: 'handleOverseasStockWorkspaceGet_', used_by: 'Overseas Inventory scoped read (owner = 70_)' }
];

// The tables the Submit-to-Map vertical slice reads or writes. Reported as present/row-count only.
var SYS_SLICE_TABLES_ = [
  'shipping_allocation_drafts', 'shipping_allocation_draft_lines',
  'shipping_plans', 'shipping_plan_lines', 'shipments', 'shipment_lines', 'shipment_line_allocations',
  'shipment_routes', 'shipment_events', 'shipment_final_output_snapshots', 'shipment_final_output_lines',
  'shipment_final_output_line_pos', 'generated_documents', 'document_templates', 'document_template_fields',
  'warehouses', 'logistics_locations'
];

function sysStr_(v) { return String(v == null ? '' : v).trim(); }
// Probe a handler symbol WITHOUT invoking it. A missing symbol is the signature of a partial file sync.
function sysHandlerPresent_(name) {
  try { return typeof this[name] === 'function'; } catch (e) { /* fall through */ }
  try { return eval('typeof ' + name) === 'function'; } catch (e2) { return false; }
}
// -------------------------------------------------------------------------------------------------------------
// F1-7N-FB-4A ADDENDUM §H — PER-MODULE BUILD STAMPS + CALLER-DRIVEN PROBES.
//
// THE PROBLEM WITH missing_actions=[] IS NOT ONLY THAT IT IS SELF-REFERENTIAL — IT IS THAT IT CANNOT SEE A
// MIXED DEPLOYMENT. If 63_ is current but 66_ is a round behind (files are copied into the Apps Script editor
// ONE AT A TIME, so a half-finished sync is the normal failure), every required action still resolves — the
// symbols exist — and health reports a clean bill while the operator runs last round's code.
//
// Two additions fix that, and neither asks the deployment to grade its own homework:
//
//   1. MODULE BUILD STAMPS. Each owner file compiles in its OWN build constant recording the round in which
//      THAT FILE last changed, and the manifest below records what each is EXPECTED to declare. This reads them
//      through `typeof` (never invoking anything) and compares. A file that was not re-copied reports an OLDER
//      build than its manifest entry, and `mixed_deployment` becomes true. The evidence comes from the OTHER
//      files, so a stale 63_ cannot conceal a stale 66_.
//
//      The stamp is deliberately NOT required to equal SYS_BUILD_VERSION_: a file that did not change this round
//      should not have to be edited to prove it is current. 67_ legitimately still declares F1-7N-FB-3C.
//      A file with no stamp at all (16_, 31_, 57_) is proven instead by the caller's SYMBOL probe below, which
//      names a global that only the current version of that file defines.
//
//      ORDERING NOTE, STATED RATHER THAN ASSUMED: the manifest itself lives in 63_, so a stale 63_ carries a
//      stale manifest. That case is caught FIRST and by different evidence — a stale 63_ reports an older
//      deployed_action_contract_version than the frontend pins, which is the check the client runs before it
//      looks at uniformity at all.
//
//   2. CALLER-DRIVEN PROBES. The caller sends the exact action names and global symbols IT needs
//      (probe_actions / probe_symbols). The answer is computed against the CALLER's list, not against the
//      deployment's own SYS_REQUIRED_ACTIONS_, so a deployment that predates an action reports it ABSENT
//      instead of reporting "nothing missing". This is the half that breaks the self-reference.
//
// Both are pure reads: `typeof` on a global, and a string lookup. Nothing is invoked and nothing is written.
// -------------------------------------------------------------------------------------------------------------
// file -> { symbol it compiles in, the build it is EXPECTED to declare (the round it last changed) }.
var SYS_MODULE_BUILD_STAMPS_ = [
  // R6-R6 §4 — SELF-REFERENTIAL BY CONSTRUCTION, AND SAID SO. Both sides of this comparison are declared in
  // this file, so it can never fail and proves nothing about 63_. A stale 63_ is caught earlier and by other
  // evidence (its deployed_action_contract_version is older than the frontend's pinned minimum). The entry is
  // kept because the row is what publishes 63_'s own module build to a reader, not because it is a check.
  { file: '63_api_v1_system_health.gs', symbol: 'SYS_BUILD_VERSION_', expected: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R1', owns: 'this module: deployment identity + health + transport contract + the effective feature-flag report (self-referential row — not a partial-sync check)' },
  // F1-7N-FC-1B-E3 §E.9 — the CONFIG is an owner file too. It holds
  // INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_, so a project still running the previous copy of it writes no
  // allocation drafts while the repository says it should; without an entry here that difference had no name.
  { file: '00_config.gs', symbol: 'CONFIG_BUILD_VERSION_', expected: 'F1-7N-FC-1B-E3-R4-A2-R1-R6', owns: 'global constants + the feature flags of record (incl. Inventory AI Plan DB generation)' },
  // F1-7N-FC-1B-E3-R1 — 61_ owns the harvest, the canonical readiness decision and the K2 generation, and
  // it carried no stamp at all: a deployment that answers HARVEST_NOT_READY with no issues and a deployment
  // that predates the typed-readiness fix were the same observation from outside. Now they are not.
  { file: '61_api_v1_weekly_ai_plan.gs', symbol: 'WAP_BUILD_VERSION_', expected: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R1', owns: 'weekly AI Plan harvest + canonical readiness refusal + K2 generation + the KMFCN forecast normalization gate' },
  { file: '60_api_v1_inventory_replenishment_workspace.gs', symbol: 'SIR_BUILD_VERSION_', expected: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R5', owns: 'the inventory workspace read + the recentWindow/only request contract + the per-table timing that names the expensive sheet + the R6-R5 router-entry/stage evidence that makes a timed-out read locatable in the execution log' },
  // F1-7N-FB-4E-R3 §C — the Overseas Stock workspace owner. Registered here because its absence is the exact
  // failure this manifest exists to name: a deployment carrying the R3 router but no 70_ would route the action
  // to an undefined handler, and the page has no fan-out left to fall back to.
  { file: '70_api_v1_overseas_stock_workspace.gs', symbol: 'OSW_BUILD_VERSION_', expected: 'F1-7N-FB-4E-R3', owns: 'Overseas Stock scoped read workspace' },
  { file: '66_api_v1_request_order_send.gs', symbol: 'ROS_BUILD_VERSION_', expected: 'F1-7N-FB-4E-R4B-R3', owns: 'Request Order Send orchestration + planning-cycle authority' },
  { file: '67_api_v1_allocation_draft_identity.gs', symbol: 'ADI_BUILD_VERSION_', expected: 'F1-7N-FB-3C', owns: 'allocation-draft identity diagnostic (unchanged since FB-3C)' },
  // F1-7N-FB-4E-R2: 68_ changed because its duplicate diagnostic became REACHABLE for the first time and
  // needed a scope guard on the routed path. A deployment carrying the R2 router but a FB-4D copy of 68_ would
  // route to a handler with no guard, so this pairing must be provable rather than assumed.
  { file: '68_api_v1_execution_plan_conflict_diagnostic.gs', symbol: 'EPC_BUILD_VERSION_', expected: 'F1-7N-FB-4E-R2', owns: 'Execution Plan identity conflict diagnostic + routed read-only duplicate-line diagnostic' },
  // 68_ did NOT change in R3, so its stamp deliberately stays at R2. A stamp bumped to look current would make
  // this manifest useless for detecting the thing it exists to detect.
  // F1-7N-FB-4D §E — the four owners the Site Inventory and SKU chains actually depend on. Each of these
  // files answers every one of its actions even when it is a round behind, so a resolvable action list can
  // never detect a partial sync of them. Only the declared build can.
  // F1-7N-FB-4F-B3 — the allocation writer learned the two append-only columns BEFORE they exist, so its stamp
  // moves and this expectation moves with it. The pair is the partial-sync detector for this deployment set:
  // sync 16_ without 63_ and the stale manifest still expects F1-7N-FB-4D; sync 63_ without 16_ and the new
  // manifest expects B3 while the file declares 4D. Either direction reports mixed_deployment.
  { file: '16_shipping_allocation_handlers.gs', symbol: 'SAD_BUILD_VERSION_', expected: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4-R2', owns: 'Execution Plan allocation draft header/line writer (schema-compatible 30..35 header / 30..31 line, route group keys)' },
  // F1-7N-FB-4F-B3 — REGISTERED HERE FOR THE REASON THIS MANIFEST EXISTS. B1 landed the route-identity contract
  // deliberately unmanifested because it was inert. It is not inert any more: 16_ now calls into it for the
  // typed schema refusals and for the K4 identity, so a deployment carrying the B3 writer WITHOUT this file
  // would refuse a marketplace route it is supposed to accept, and would fall back to K2 for a route the
  // writer believes is K4-resolved. That is exactly the half-finished sync this manifest is here to name.
  { file: '69_api_v1_route_identity_contract.gs', symbol: 'RIC_BUILD_VERSION_', expected: 'F1-7N-FB-4F-B3', owns: 'frozen route identity contract (canonical service, destination XOR, K4 key, typed schema refusals)' },
  { file: '11_shipping_plan_handlers.gs', symbol: 'SP_BUILD_VERSION_', expected: 'F1-7N-FC-1A', owns: 'canonical shipping_plans / shipping_plan_lines Submit owner + the typed approval-recovery answer' },
  // F1-7N-FC-1A §J — THE FOUR OWNERS OF THE RESERVATION MODEL. Each answers every one of its actions
  // when a round behind, so no resolvable action list and no handler probe can see a partial sync of them.
  // What each one does differently is the point:
  //   21_  no reservation primitives at all: 12_ and 22_ throw on an undefined function.
  //   12_  creates Shipment Drafts that reserve NOTHING, while the site believes reservation is live.
  //   22_  deducts through its OLD inline implementation and never RELEASES the reservation, so available
  //        stock drifts permanently downward and shipments are refused for stock that is physically present.
  // The 12_ and 22_ cases are the dangerous ones precisely because they return success.
  { file: '21_factory_inventory_handlers.gs', symbol: 'FSTX_BUILD_VERSION_', expected: 'F1-7N-FC-1A-R1', owns: 'THE single factory_stock mutation authority + the canonical seven-type movement vocabulary + reserved-balance reconciliation' },
  { file: '12_shipment_handlers.gs', symbol: 'SHIPMENT_BUILD_VERSION_', expected: 'F1-7N-FC-1A-R1', owns: 'Shipment Draft creation + reservation acquire, pre-dispatch cancellation + reservation release, and the updateShipment status allowlist' },
  // F1-7N-FC-1A-R1 §K — the PO receipt owner gains a stamp, because an old 13_ ALSO returns success.
  // It silently CLAMPS an over-receipt: an operator entering 900 against a remaining 500 is told the receipt
  // succeeded and is never told the other 400 were discarded. Only a declared build separates that from a
  // deployment that refuses properly.
  { file: '13_procurement_handlers.gs', symbol: 'PROC_BUILD_VERSION_', expected: 'F1-7N-FC-1A-R1', owns: 'PO receipt factory-stock handoff + the typed PO_RECEIPT_EXCEEDS_REMAINING_QTY refusal (no silent clamp)' },
  { file: '22_shipment_dispatch_handlers.gs', symbol: 'CSD_BUILD_VERSION_', expected: 'F1-7N-FC-1A-R1', owns: 'Confirm Shipment & Dispatch: deduction + reservation release through the shared authority + the cancelled-shipment dispatch refusal' },
  // F1-7N-FB-4E-R4B-R3 §1 - moved with the file. R4B-R2 changed the GET read dispatch; leaving the manifest at
  // R4A1 would have made a CORRECTLY synced router report as stale, and an UNSYNCED one report as current.
  { file: '01_router.gs', symbol: 'RTR_BUILD_VERSION_', expected: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R5', owns: 'doGet/doPost action routing (incl. the GET read table + cancelShipmentDraft) + typed handler/method response identity + the R6-R5 per-execution entry stamp handlers report as server evidence' },
  // F1-7N-FB-4E-R4B-R3 §1 - THE TWO OWNERS THAT CHANGED IN R4B AND HAD NO STAMP AT ALL. Both answer every one of
  // their actions when a round behind, so a resolvable action list can never see a partial sync of them; only a
  // declared build can. The stamp VALUE names the round in which each last changed BEHAVIOURALLY; the SYMBOL was
  // introduced in R4B-R3, so a copy older than R3 reports ABSENT rather than stale - a stronger signal, not a
  // weaker one, and the reason the value is not bumped to R3 just to look current.
  { file: '47_api_v1_recommendation_generation.gs', symbol: 'RECGEN_BUILD_VERSION_', expected: 'F1-7N-FB-4E-R4B-R2', owns: 'recommendation generation + the bounded multi-scope order-draft readback' },
  { file: '56_api_v1_ai_plan_first_layer.gs', symbol: 'APL_BUILD_VERSION_', expected: 'F1-7N-FB-4E-R4B-R1', owns: 'Order Planning AI Plan first layer + the KMFSA factory site-allocation share' },
  { file: '59_api_v1_sku_details_workspace.gs', symbol: 'SKD_BUILD_VERSION_', expected: 'F1-7N-FB-4C-R1', owns: 'SKU Details / SKU Regional scoped read workspace' },
  // F1-7N-FB-4G-A2-R4 SS.J - the Request Order Send diagnostic STATUS ACTION is required in production, so its
  // owner may not be a file whose whole contract is that it gets deleted. It moved into 66_, and the manifest
  // follows it: a deployment is now complete WITHOUT the TEMP diagnostics file, which is what makes
  // 'paste, run, remove' safe again. 66_ appears twice on purpose - two symbols, two independent lifecycles.
  { file: '66_api_v1_request_order_send.gs', symbol: 'ROSEND_DIAG_BUILD_VERSION_', expected: 'F1-7N-FB-4G-A2-R4', owns: 'Request Order Send diagnostic status action + its configuration (single owner)' },
  // F1-7N-FB-4C — the AI Plan draft lifecycle. Registered here because its ABSENCE is silent: the generator would
  // still write its own rows and simply expire nothing, leaving last week's plan active and looking like advice.
  { file: '69_api_v1_ai_plan_lifecycle.gs', symbol: 'AIPL_BUILD_VERSION_', expected: 'F1-7N-FC-1B-E3-R4-A2-R1-R1', owns: 'Inventory AI Plan draft lifecycle (expiration of superseded AI drafts)' },
  // F1-7N-FB-4C-ADDENDUM-MIGRATION — the USER-run lifecycle schema migration. Registered because its absence is
  // ACTIONABLE: the AI Plan will refuse to run until the columns exist, and the only supported way to add them is
  // this tool. Without the entry, "the run is blocked" and "the tool that unblocks it was never synced" look the same.
  // F1-7N-FB-4G-A2-R4 §J.6 — OPTIONAL: a one-shot MIGRATION owner. It is MUST_KEEP_UNTIL_MIGRATION,
  // and once the migration has run the operator is told to remove it. Treating its absence as a MIXED
  // deployment made "remove the TEMP file" break the deployment contract — the same shape that took the
  // Execution Plan down through the diagnostics file. Absent is fine; PRESENT-BUT-STALE is still a fault.
  { file: 'TEMP_migrate_shipping_allocation_ai_lifecycle.gs', symbol: 'TEMP_AIMIG_BUILD_VERSION_', expected: 'F1-7N-FB-4C-ADDENDUM-MIGRATION', owns: 'AI Plan lifecycle schema migration (append-only columns + source-proven lineage backfill)', optional: true },
];

function sysGlobalValue_(name) {
  try { return eval('typeof ' + name + " !== 'undefined' ? " + name + ' : undefined'); }
  catch (e) { return undefined; }
}

function sysModuleBuildStamps_() {
  var rows = SYS_MODULE_BUILD_STAMPS_.map(function (m) {
    var v = sysGlobalValue_(m.symbol);
    var present = (v !== undefined && v !== null && String(v) !== '');
    return {
      file: m.file, symbol: m.symbol, owns: m.owns, optional: m.optional === true,
      expected_build: m.expected,
      present: present,
      declared_build: present ? String(v) : null,
      matches_expected: present ? (String(v) === m.expected) : false
    };
  });
  // §J.6 — an OPTIONAL owner (a one-shot migration file the operator is told to remove) may be absent
  // without that being a partial sync. A stale one is still a fault: a wrong version is never expected.
  var absent = rows.filter(function (r) { return !r.present && !r.optional; });
  var absent_optional = rows.filter(function (r) { return !r.present && r.optional; });
  var stale = rows.filter(function (r) { return r.present && !r.matches_expected; });
  // §10 — the executed invariant, which a version string cannot fake in either direction.
  var runtime = sysRuntimeAuthorityChecks_();
  return {
    deployment_build: SYS_DEPLOYMENT_RELEASE_,          // the RELEASE, not this module's stamp
    modules: rows,
    runtime_authority: runtime,
    absent_modules: absent.map(function (r) { return r.file; }),
    absent_optional_modules: absent_optional.map(function (r) { return r.file; }),
    stale_modules: stale.map(function (r) { return r.file + ' declares ' + r.declared_build + ', expected ' + r.expected_build; }),
    // A runtime divergence IS a mixed deployment, whatever the labels say. This is the half that would have
    // caught the live R4 state, where every label matched and the two resolvers did not.
    mixed_deployment: (absent.length + stale.length) > 0 || runtime.uniform !== true,
    verdict: ((absent.length + stale.length) === 0 && runtime.uniform === true)
      ? 'UNIFORM — every probed owner file declares the build its manifest entry expects, AND the writer and '
        + 'lifecycle resolve identically at every known schema generation'
      : (runtime.uniform !== true
          ? 'MIXED_OR_PARTIAL_SYNC (RUNTIME) — ' + runtime.verdict
          : 'MIXED_OR_PARTIAL_SYNC — at least one owner file is absent from, or older than, what this deployment expects. Re-copy the files listed and publish a NEW deployment version.')
  };
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R5 §10 — A LABEL COMPARED WITH A LABEL CANNOT SEE A STALE BODY.
//
// The live R4 census reported writer FB4G, lifecycle null, shares_authority FALSE — and this contract, in the
// same run, reported UNIFORM. Both were correct about what they measured. The contract compares the string a
// file DECLARES with the string the manifest EXPECTS, and three owner files had labels that were never rotated
// when their behaviour changed, so a stale deployed body and a stale expectation agreed with each other.
// Rotating the three labels fixes those three instances; it does not fix the METHOD, and the next round that
// edits a file and forgets its stamp reproduces this exactly.
//
// So the contract now also EXECUTES the invariant it cares about. This cannot be fooled by a label, does not
// depend on Apps Script file ordering, and does not care which copy of a function won the global scope: it
// hands the SAME header row to the writer's resolver and to the lifecycle's, and compares the answers. If a
// project is running a lifecycle body that predates the delegation, the two disagree here and the deployment is
// reported MIXED however tidy its version strings are.
//
// It probes EVERY known schema generation rather than one, because the pre-delegation body agrees with the
// shared authority at exactly one shape (the 34-column canonical) and disagrees at the others — so a
// single-shape probe would have passed on the very deployment that motivated this.
//
// Pure reads: resolver calls over synthetic header arrays. No sheet is opened and nothing is written.
// ================================================================================================================
function sysRuntimeAuthorityChecks_() {
  // `checked` and `uniform` are DIFFERENT questions, and collapsing them makes the check dishonest in both
  // directions. A project that does not compile 16_ or 69_ at all is already named by absent_modules, so
  // reporting that a second time as a runtime DIVERGENCE would be one fault wearing two names. What this
  // check asserts is narrower, and is the thing a label cannot see: where both authorities ARE present,
  // they agree.
  var out = { checked: false, checks: [], divergent: [], missing_authority: [], uniform: true,
    contract: 'where both authorities are present they must resolve the SAME version from the SAME header, at every known generation' };
  var haveSad = (typeof sadResolveHeaderSchema_ === 'function');
  var haveAipl = (typeof aiplSchemaVersionOf_ === 'function');
  if (!haveSad) out.missing_authority.push('sadResolveHeaderSchema_ (16_shipping_allocation_handlers.gs)');
  if (!haveAipl) out.missing_authority.push('aiplSchemaVersionOf_ (69_api_v1_ai_plan_lifecycle.gs)');
  if (typeof SHIPPING_ALLOCATION_DRAFTS_HEADERS_ === 'undefined'
      || typeof SAD_HEADER_OPTIONAL_TAIL_COLUMNS_ === 'undefined') {
    out.missing_authority.push('SHIPPING_ALLOCATION_DRAFTS_HEADERS_ / SAD_HEADER_OPTIONAL_TAIL_COLUMNS_');
  }
  if (out.missing_authority.length) {
    // NOT a divergence: nothing was compared, so nothing disagreed. `checked` says so plainly.
    out.verdict = 'RUNTIME_AUTHORITY_NOT_CHECKED — ' + out.missing_authority.join('; ')
      + ' (absent owners are reported by the module manifest, not duplicated here)';
    return out;
  }
  out.checked = true;
  var full = SHIPPING_ALLOCATION_DRAFTS_HEADERS_.concat(SAD_HEADER_OPTIONAL_TAIL_COLUMNS_);
  var shapes = [];
  for (var i = 0; i < (typeof SAD_SCHEMA_GENERATIONS_ !== 'undefined' ? SAD_SCHEMA_GENERATIONS_.length : 0); i++) {
    var g = SAD_SCHEMA_GENERATIONS_[i];
    shapes.push(SHIPPING_ALLOCATION_DRAFTS_HEADERS_.concat(g.appended || []).length);
  }
  if (!shapes.length) shapes = [full.length];
  shapes.forEach(function (n) {
    var hdr = full.slice(0, n);
    var w = null, l = null, err = null;
    try { w = sadResolveHeaderSchema_(hdr); } catch (e1) { err = String(e1 && e1.message || e1); }
    try { l = aiplSchemaVersionOf_(hdr) || null; } catch (e2) { err = (err || '') + ' ' + String(e2 && e2.message || e2); }
    var writerVersion = (w && w.ok) ? w.version : null;
    var lifecycleComplete = !!(w && w.lifecycle_complete);
    // The lifecycle deliberately returns nothing for a generation that is not lifecycle-complete, so THAT is
    // agreement, not divergence. Divergence is: the writer says this generation IS lifecycle-complete and the
    // lifecycle either names nothing or names something else.
    var expectLifecycle = (writerVersion && lifecycleComplete) ? writerVersion : null;
    var agree = (l === expectLifecycle) && !err;
    var row = { column_count: n, writer_version: writerVersion, writer_lifecycle_complete: lifecycleComplete,
      lifecycle_version: l, expected_lifecycle_version: expectLifecycle, agree: agree, error: err };
    out.checks.push(row);
    if (!agree) {
      out.uniform = false;
      out.divergent.push('at ' + n + ' columns the writer resolves ' + (writerVersion || '(none)')
        + ' and the lifecycle resolves ' + (l || '(none)'));
    }
  });
  out.verdict = out.uniform
    ? 'UNIFORM — the writer and the lifecycle resolve identically at every known schema generation'
    : 'RUNTIME_AUTHORITY_DIVERGENCE — the deployed lifecycle body does not share the writer\'s schema authority. '
      + 'Re-copy 69_api_v1_ai_plan_lifecycle.gs (and 16_shipping_allocation_handlers.gs) and publish a NEW '
      + 'deployment version. Version strings may look correct and be stale.';
  return out;
}

// Answer the CALLER's list. `probe_actions` are checked against the router's action->handler map AND the actual
// presence of the handler symbol; `probe_symbols` are checked by `typeof` alone. Absent entries are reported as
// absent — that is the whole point, and it is what an empty self-referential missing_actions could never say.
function sysProbeRequested_(body) {
  function arr(v) { if (!v) return []; if (!Array.isArray(v)) v = [v]; return v.map(sysStr_).filter(function (x) { return !!x; }); }
  var wantActions = arr(body && (body.probe_actions || body.probeActions));
  var wantSymbols = arr(body && (body.probe_symbols || body.probeSymbols));
  if (!wantActions.length && !wantSymbols.length) return null;
  var byAction = {};
  for (var i = 0; i < SYS_REQUIRED_ACTIONS_.length; i++) byAction[SYS_REQUIRED_ACTIONS_[i].action] = SYS_REQUIRED_ACTIONS_[i].handler;
  var actions = wantActions.map(function (a) {
    var handler = byAction[a] || null;
    // A caller-named action the deployment does not even LIST is reported unknown-to-this-build, which is
    // exactly the "older than the frontend" signal. Where the handler name is known, its symbol is probed.
    var present = handler ? (sysGlobalValue_(handler) !== undefined) : false;
    return { action: a, known_to_this_build: !!handler, handler: handler, handler_present: present, available: !!handler && present };
  });
  var symbols = wantSymbols.map(function (n) { return { symbol: n, present: sysGlobalValue_(n) !== undefined }; });
  var missingActions = actions.filter(function (a) { return !a.available; }).map(function (a) { return a.action; });
  var missingSymbols = symbols.filter(function (sy) { return !sy.present; }).map(function (sy) { return sy.symbol; });
  return {
    requested_by_caller: true,
    actions: actions, symbols: symbols,
    missing_actions: missingActions, missing_symbols: missingSymbols,
    all_present: missingActions.length === 0 && missingSymbols.length === 0,
    note: 'Computed against the CALLER\'s list, not against this deployment\'s own required-action list, so it is NOT self-referential.'
  };
}

function sysRouterReadiness_() {
  var rows = [], missing = [];
  for (var i = 0; i < SYS_REQUIRED_ACTIONS_.length; i++) {
    var a = SYS_REQUIRED_ACTIONS_[i];
    var present = sysHandlerPresent_(a.handler);
    rows.push({ action: a.action, available: present, used_by: a.used_by });
    if (!present) missing.push(a.action);
  }
  return { entrypoints: { doGet: sysHandlerPresent_('doGet'), doPost: sysHandlerPresent_('doPost') },
    actions: rows, missing_actions: missing, all_available: missing.length === 0 };
}
// Header/row readiness WITHOUT leaking the schema: a present flag, a header count and a row count only.
function sysSchemaReadiness_(ss) {
  var out = [], missing = 0;
  for (var i = 0; i < SYS_SLICE_TABLES_.length; i++) {
    var name = SYS_SLICE_TABLES_[i], sheet = null;
    try { sheet = ss.getSheetByName(name); } catch (e) { sheet = null; }
    if (!sheet) { out.push({ table: name, present: false, header_count: 0, row_count: 0 }); missing++; continue; }
    var lastRow = 0, lastCol = 0;
    try { lastRow = sheet.getLastRow(); lastCol = sheet.getLastColumn(); } catch (e2) {}
    out.push({ table: name, present: true, header_count: lastCol, row_count: Math.max(0, lastRow - 1) });
  }
  return { tables: out, missing_table_count: missing, all_present: missing === 0 };
}

// ---- the canonical health action ------------------------------------------------------------------------
// Returns ONLY operational facts. Deliberately absent: spreadsheet id, Drive ids, tokens, user identity, any
// business row. A caller that receives this JSON has proven the deployment is reachable AND that the deployed
// code contains the actions it is about to use.
function handleSystemHealth_(body) {
  var requestId = sysStr_(body && (body.requestId || body.request_id)) || ('HEALTH-' + Utilities.getUuid().substring(0, 8).toUpperCase());
  var started = Date.now();
  var router = sysRouterReadiness_();
  var schema = { tables: [], missing_table_count: null, all_present: null, error: '' };
  var dbReachable = false;
  try {
    var ss = SpreadsheetApp.openById(prodExpectedDbId_());
    dbReachable = true;
    schema = sysSchemaReadiness_(ss);
  } catch (e) {
    // Never echo the id or the raw message shape that could contain it.
    schema.error = 'DB_NOT_REACHABLE';
  }
  var ok = router.all_available && dbReachable && schema.all_present === true;
  var moduleStamps = sysModuleBuildStamps_();
  var callerProbe = sysProbeRequested_(body);
  if (moduleStamps.mixed_deployment) ok = false;   // a partial sync is NOT a healthy deployment
  if (callerProbe && !callerProbe.all_present) ok = false;
  return jsonResponse_({
    success: true,
    ok: ok,
    // F1-7N-FB-3A §C — the IMMUTABLE deployment identity block. Every field here is a constant compiled into
    // the answering code, so together they identify exactly which deployment replied.
    // R6-R6 §4 — build_id is the DEPLOYMENT RELEASE. The frontend already reads it that way (it prints
    // "deployment build" in the partial-sync error), so this makes the server agree with its only consumer
    // rather than inventing a new field the consumer would ignore.
    build_id: SYS_DEPLOYMENT_RELEASE_,
    deployment_release: SYS_DEPLOYMENT_RELEASE_,
    // The four module builds an operator compares against it, each named for the file it comes from, so
    // "which of these is the deployment?" stops being a question. A null here is an ABSENT file, which is a
    // different fault from a stale one and must not look like it.
    system_health_module_build: SYS_BUILD_VERSION_,
    workspace_module_build: (typeof SIR_BUILD_VERSION_ !== 'undefined') ? SIR_BUILD_VERSION_ : null,
    contract_version: SYS_API_CONTRACT_VERSION_,
    // F1-7N-FB-4E §H — the transport axis, plus the router's own build and the identity fields it can emit.
    // A frontend compares all three: a mismatch on the ACTION contract means "publish a deployment with this
    // action"; a mismatch here means "publish a deployment whose ROUTER can name its own handler"; and neither
    // is the same fault as an endpoint that never reached Apps Script at all (which never gets this far).
    transport_contract_version: SYS_TRANSPORT_CONTRACT_VERSION_,
    router_build: (typeof RTR_BUILD_VERSION_ !== 'undefined') ? RTR_BUILD_VERSION_ : null,
    router_response_identity: {
      emits_handler: true, emits_received_method: true, emits_post_body_present: true,
      emits_action_present_in_query: true, emits_router_build: true
    },
    // The handler that answered THIS probe. system.health is routed on both verbs, so a caller can prove which
    // entry point served it instead of inferring it from a message.
    handler: (body && body.__km_handler) ? String(body.__km_handler) : 'doPost',
    received_method: (body && body.__km_handler === 'doGet') ? 'GET' : 'POST',
    request_order_send_diagnostic_owner: (typeof ROSEND_DIAG_OWNER_FILE_ !== 'undefined') ? ROSEND_DIAG_OWNER_FILE_ : null,
    deployed_action_contract_version: SYS_DEPLOYED_ACTION_CONTRACT_VERSION_,
    inventory_registry_projection_version: (typeof SCOPEREG_PROJECTION_VERSION_ !== 'undefined') ? SCOPEREG_PROJECTION_VERSION_ : null,
    // F1-7N-FC-1B-E3 §E.6/§E.7 — THE EFFECTIVE FEATURE-FLAG VALUE, read from the function that
    // every gate reads, in the deployment that is actually answering. Not the repository's copy of the file and
    // not the frontend's mirror: those can disagree with this, and when they do, THIS is the one that decides
    // whether a Generate AI Plan click writes anything. `null` means the config file is not present in the
    // deployment at all, which is a different fault from the flag being off.
    inventory_ai_plan_db_generation_enabled: (typeof inventoryAiPlanDbGenerationEnabled_ === 'function')
      ? (inventoryAiPlanDbGenerationEnabled_() === true) : null,
    config_build: (typeof CONFIG_BUILD_VERSION_ !== 'undefined') ? CONFIG_BUILD_VERSION_ : null,
    required_action_list_version: SYS_REQUIRED_ACTION_LIST_VERSION_,
    required_action_count: SYS_REQUIRED_ACTIONS_.length,
    // An EMPTY missing_actions list proves nothing on its own — see the note at the constants above. This flag
    // makes that explicit in the payload so a reader cannot mistake one for a completeness guarantee.
    missing_actions_is_self_referential: true,
    // FB-4A ADDENDUM §H — the two NON-self-referential proofs. module_build_stamps reports each owner file's own
    // compiled build constant (so a half-finished file-by-file sync is a named fact), and caller_probe answers
    // the CALLER's explicit action/symbol list (so a deployment that predates an action says so).
    module_build_stamps: moduleStamps,
    mixed_deployment: moduleStamps.mixed_deployment,
    deployment_uniformity_verdict: moduleStamps.verdict,
    caller_probe: callerProbe,
    api_contract_version: SYS_API_CONTRACT_VERSION_,
    // Legacy alias for build_id — the frontend falls back to it, so it must carry the RELEASE too.
    build_version: SYS_DEPLOYMENT_RELEASE_,
    environment_mode: 'production',
    router_ready: router.all_available,
    entrypoints: router.entrypoints,
    required_actions: router.actions,
    missing_actions: router.missing_actions,
    db_reachable: dbReachable,
    schema_ready: schema.all_present,
    schema: { missing_table_count: schema.missing_table_count, tables: schema.tables, error: schema.error },
    server_timestamp: (typeof shipmentTimestamp_ === 'function') ? shipmentTimestamp_() : new Date().toISOString(),
    server_ms: Date.now() - started,
    request_id: requestId,
    read_only: true, db_writes: 0, drive_writes: 0, status_transitions: 0, emails: 0, demo_mutations: 0
  });
}

// ---- §K read-only Submit-to-Map flow readiness -----------------------------------------------------------
// Answers "would Submit Plan actually persist, and can the resulting plan reach the map?" WITHOUT writing a
// single cell. It validates the payload shape and the persisted allocation drafts the canonical Submit owner
// re-reads; it never inserts, never transitions and never touches Drive.
function handleSubmitFlowDiagnostic_(body) {
  var requestId = sysStr_(body && (body.requestId || body.request_id)) || ('FLOW-' + Utilities.getUuid().substring(0, 8).toUpperCase());
  var draftIds = (body && body.allocation_draft_ids) || [];
  if (!Array.isArray(draftIds)) draftIds = [draftIds];
  draftIds = draftIds.map(sysStr_).filter(function (x) { return !!x; });
  var out = {
    success: true, request_id: requestId,
    read_only: true, db_writes: 0, drive_writes: 0, status_transitions: 0, emails: 0, demo_mutations: 0,
    api_contract_version: SYS_API_CONTRACT_VERSION_, build_version: SYS_DEPLOYMENT_RELEASE_
  };
  var router = sysRouterReadiness_();
  out.router_ready = router.all_available;
  out.missing_actions = router.missing_actions;
  var ss;
  try { ss = SpreadsheetApp.openById(prodExpectedDbId_()); }
  catch (e) { out.verdict = 'BLOCKED'; out.blocking_reasons = [{ reason: 'DB_NOT_REACHABLE' }]; return jsonResponse_(out); }
  out.schema = sysSchemaReadiness_(ss);

  // the canonical Submit owner re-reads persisted allocation drafts; report what it WOULD find
  var drafts = [];
  try {
    var sh = ss.getSheetByName('shipping_allocation_drafts');
    if (sh) {
      var d = sh.getDataRange().getValues();
      if (d.length > 1) {
        var h = d[0].map(function (x) { return sysStr_(x).toLowerCase(); });
        var cId = h.indexOf('allocation_draft_id'), cStatus = h.indexOf('status');
        for (var r = 1; r < d.length; r++) {
          var id = cId === -1 ? '' : sysStr_(d[r][cId]);
          if (!id) continue;
          if (draftIds.length && draftIds.indexOf(id) === -1) continue;
          drafts.push({ allocation_draft_id: id, status: cStatus === -1 ? '' : sysStr_(d[r][cStatus]) });
        }
      }
    }
  } catch (e2) { /* absent table -> reported below as zero drafts */ }
  out.requested_draft_ids = draftIds;
  out.matched_drafts = drafts.length;
  out.drafts = drafts.slice(0, 20);

  // the exact rows a successful Submit is expected to create - a manifest, not a write
  out.expected_write_manifest = [
    { table: 'shipping_plans', operation: 'INSERT', rows: 'one per (country, marketplace, shipping_method) group' },
    { table: 'shipping_plan_lines', operation: 'INSERT', rows: 'one per submitted SKU line, each referencing its persisted shipping_plan_id' }
  ];
  out.expected_visibility_after_submit = [
    { page: 'Weekly Shipping Plan', shows: 'the new plan in the Draft group, read through weeklyShipping.workspace.get' },
    { page: 'Shipment Draft', shows: 'nothing yet — a shipment exists only after the plan is approved and transferred' },
    { page: 'On-the-Way Map', shows: 'nothing yet — the map needs a shipment with routes/events, created by Confirm Shipment' }
  ];
  var blockers = [];
  if (!router.all_available) blockers.push({ reason: 'ROUTER_ACTION_MISSING', detail: router.missing_actions.join(',') });
  if (!out.schema.all_present) blockers.push({ reason: 'SCHEMA_TABLE_MISSING', detail: String(out.schema.missing_table_count) + ' table(s) absent' });
  if (draftIds.length && !drafts.length) blockers.push({ reason: 'ALLOCATION_DRAFT_NOT_FOUND', detail: 'none of the supplied allocation_draft_id values exist' });
  if (!draftIds.length && !drafts.length) blockers.push({ reason: 'NO_PERSISTED_ALLOCATION_DRAFT', detail: 'Submit re-reads persisted drafts; adjust the Execution Plan first so one is saved.' });
  out.blocking_reasons = blockers;
  out.verdict = blockers.length ? 'BLOCKED' : 'READY';
  return jsonResponse_(out);
}

// ---- editor-runnable wrapper (§K) -----------------------------------------------------------------------
// Paste an allocation_draft_id to scope the flow check, or leave the placeholder to report unscoped readiness.
var TEMP_FLOW_DIAGNOSTIC_ALLOCATION_DRAFT_ID_ = 'PASTE_ALLOCATION_DRAFT_ID_HERE_OR_LEAVE_BLANK';

function TEMP_SYSTEM_HEALTH_CHECK() {
  var h = {};
  try { h = JSON.parse(handleSystemHealth_({}).getContent()); } catch (e) { Logger.log('[SYS-HEALTH] UNPARSEABLE'); return; }
  Logger.log('[SYS-HEALTH][identity] build_id=' + h.build_id +
    ' contract_version=' + h.contract_version +
    ' deployed_action_contract_version=' + h.deployed_action_contract_version +
    ' inventory_registry_projection_version=' + h.inventory_registry_projection_version +
    ' required_action_list_version=' + h.required_action_list_version +
    ' required_action_count=' + h.required_action_count);
  Logger.log('[SYS-HEALTH][identity] NOTE: missing_actions is computed from the DEPLOYED code\'s own required-action ' +
    'list, so an EMPTY list is NOT proof that this deployment is complete. Compare the version fields above.');
  Logger.log('[SYS-HEALTH][identity] NOTE: running this wrapper in the EDITOR proves the code is SAVED. It does NOT ' +
    'prove the /exec WEB APP serves it — that requires a new deployment version.');
  Logger.log('[SYS-HEALTH] ok=' + h.ok +
    ' contract=' + h.api_contract_version + ' build=' + h.build_version + ' env=' + h.environment_mode +
    ' | router_ready=' + h.router_ready + ' doGet=' + (h.entrypoints && h.entrypoints.doGet) + ' doPost=' + (h.entrypoints && h.entrypoints.doPost) +
    ' missing_actions=[' + (h.missing_actions || []).join(',') + ']' +
    ' | db_reachable=' + h.db_reachable + ' schema_ready=' + h.schema_ready +
    ' missing_tables=' + (h.schema && h.schema.missing_table_count) +
    ' | server_ms=' + h.server_ms + ' request_id=' + h.request_id +
    ' | READ_ONLY=' + h.read_only + ' DB_WRITES=' + h.db_writes + ' DRIVE_WRITES=' + h.drive_writes +
    ' STATUS_TRANSITIONS=' + h.status_transitions + ' EMAILS=' + h.emails + ' DEMO_MUTATIONS=' + h.demo_mutations);
  ((h.schema && h.schema.tables) || []).forEach(function (t) {
    if (!t.present) Logger.log('[SYS-HEALTH][table] MISSING ' + t.table);
  });
}

function TEMP_SUBMIT_FLOW_DIAGNOSE() {
  var raw = sysStr_(TEMP_FLOW_DIAGNOSTIC_ALLOCATION_DRAFT_ID_);
  var ids = (!raw || raw.indexOf('PASTE_') === 0) ? [] : [raw];
  var d = {};
  try { d = JSON.parse(handleSubmitFlowDiagnostic_({ allocation_draft_ids: ids }).getContent()); }
  catch (e) { Logger.log('[SUBMIT-FLOW] UNPARSEABLE'); return; }
  Logger.log('[SUBMIT-FLOW] verdict=' + d.verdict +
    ' | router_ready=' + d.router_ready + ' missing_actions=[' + (d.missing_actions || []).join(',') + ']' +
    ' | schema_ready=' + (d.schema && d.schema.all_present) + ' missing_tables=' + (d.schema && d.schema.missing_table_count) +
    ' | requested_drafts=[' + (d.requested_draft_ids || []).join(',') + '] matched=' + d.matched_drafts +
    ' | blocked_by=[' + (d.blocking_reasons || []).map(function (b) { return b.reason; }).join(',') + ']' +
    ' | request_id=' + d.request_id +
    ' | READ_ONLY=' + d.read_only + ' DB_WRITES=' + d.db_writes + ' DRIVE_WRITES=' + d.drive_writes +
    ' STATUS_TRANSITIONS=' + d.status_transitions + ' EMAILS=' + d.emails + ' DEMO_MUTATIONS=' + d.demo_mutations);
  (d.expected_write_manifest || []).forEach(function (m) {
    Logger.log('[SUBMIT-FLOW][would-write] ' + m.table + ' ' + m.operation + ' — ' + m.rows);
  });
  (d.expected_visibility_after_submit || []).forEach(function (v) {
    Logger.log('[SUBMIT-FLOW][visibility] ' + v.page + ' — ' + v.shows);
  });
  (d.blocking_reasons || []).forEach(function (b) { Logger.log('[SUBMIT-FLOW][blocker] ' + b.reason + ' — ' + (b.detail || '')); });
}


// ============================================================================================================
// F1-7N-FB-2A §F — READ-ONLY Execution Plan (shipping allocation draft) SAVE READINESS.
// ------------------------------------------------------------------------------------------------------------
// WHY. The production failure was a bare `BUSINESS_COMMAND_ERROR` on `upsertShippingAllocationDraft`. That is
// not a backend reason: it is the browser's fallback label for a handler error string it had no code for, and
// the UI then rendered the message — the only field carrying the real reason — nowhere at all. This diagnostic
// makes the system state the reason instead of anyone guessing it.
//
// HOW. It does NOT reimplement a single business rule. It runs the very gates the write runs, in the same
// order, against the same live tables:
//   1. prodRequireSheet_ / prodRequireColumns_ — the VALIDATE-ONLY schema gate that is the first thing
//      sadUpsertDraftHeaderCore_ touches (via procurementEnsureSheet_). It mutates nothing and throws a
//      deterministic PRODUCTION_SAFETY:<token>; that token is the highest-value answer this can return, because
//      it fires before any payload logic and proves a zero-write refusal.
//   2. sadHeaderRouteIsComplete_ — the real route-completeness predicate.
//   3. sadResolveActiveDraftK2OrK3_ — the real identity/idempotency authority (CREATE / REUSE / CONFLICT /
//      BLOCK), which is also what decides INSERT vs UPDATE and the deterministic primary key.
//   4. sadLegacyReconcileReason_ — the real guard for editing an existing row.
//   5. auditShippingAllocationSchemaReadOnly (41_) — the existing production header-drift evidence report.
// Every call above is a READ. Nothing here creates a sheet, appends a column, writes a cell, takes a lock,
// touches Drive, sends mail or alters Demo data. It NEVER calls procurementEnsureSheet_ on a missing tab path
// that could provision, never calls a handler, and never claims a write/read round trip occurred.
//
// It returns no spreadsheet id, Drive id, token or credential. Row content is never echoed: identities are
// reported as ids the caller already supplied or as deterministic hashes of the caller's own payload.
// ============================================================================================================

// Editor-run inputs. Leave a PASTE_ placeholder to skip that part of the evaluation.
//
// F1-7N-FB-3 §E — you NEVER need to invent a field name here. The objects below are PREFILLED with the exact
// canonical keys the writer accepts; you only replace VALUES. The editable value fields are exactly these, and
// nothing else in this file should be edited:
//   TEMP_SAD_DIAGNOSTIC_ALLOCATION_DRAFT_ID_  — an existing allocation_draft_id, or leave blank
//   TEMP_SAD_DIAGNOSTIC_HEADER_.company                                  (e.g. 'KM')
//   TEMP_SAD_DIAGNOSTIC_HEADER_.country                                  (e.g. 'US')
//   TEMP_SAD_DIAGNOSTIC_HEADER_.marketplace                              (e.g. 'Amazon')
//   TEMP_SAD_DIAGNOSTIC_HEADER_.recommended_source_warehouse_id          the From warehouse_id
//   TEMP_SAD_DIAGNOSTIC_HEADER_.recommended_destination_warehouse_id     the To warehouse_id, OR leave blank and set
//   TEMP_SAD_DIAGNOSTIC_HEADER_.destination_marketplace                  …this instead for an Amazon logical To
//   TEMP_SAD_DIAGNOSTIC_HEADER_.recommended_shipping_method              the Method
//   TEMP_SAD_DIAGNOSTIC_HEADER_.recommended_last_mile_delivery           optional
//   TEMP_SAD_DIAGNOSTIC_HEADER_.planning_cycle                           optional
//   TEMP_SAD_DIAGNOSTIC_LINE_.sku / .planned_qty / .required_by_date     one representative line
// Do NOT add, rename or remove keys — the key set IS the writer's contract.
//
// If you only need to know whether the TABLE/HEADER contract itself would refuse the write, run the
// ZERO-CONFIGURATION diagnostic instead: TEMP_SHIPPING_ALLOCATION_SCHEMA_DIAGNOSE (65_) needs no input at all.
var TEMP_SAD_DIAGNOSTIC_ALLOCATION_DRAFT_ID_ = 'PASTE_ALLOCATION_DRAFT_ID_HERE_OR_LEAVE_BLANK';
// The header payload to evaluate — exactly the shape buildDraftHeaderPayload sends. Fill in the scope + route
// you are trying to save; blanks are reported as missing rather than guessed.
var TEMP_SAD_DIAGNOSTIC_HEADER_ = {
  planning_cycle: '',
  source_page: 'inventory_replenishment',
  company: 'PASTE_COMPANY_OR_LEAVE_BLANK',
  country: 'PASTE_COUNTRY_OR_LEAVE_BLANK',
  marketplace: 'PASTE_MARKETPLACE_OR_LEAVE_BLANK',
  recommended_source_warehouse_id: '',
  recommended_destination_warehouse_id: '',
  destination_marketplace: '',
  recommended_shipping_method: '',
  recommended_last_mile_delivery: ''
};
// One representative line, to exercise the real line-completeness + date canonicalization predicates.
var TEMP_SAD_DIAGNOSTIC_LINE_ = { sku: '', planned_qty: 0, required_by_date: '' };

function sadDiagPlaceholder_(v) {
  var s = sysStr_(v);
  return s === '' || s.indexOf('PASTE_') === 0;
}
function sadDiagClean_(obj) {
  var out = {};
  for (var k in obj) { if (!Object.prototype.hasOwnProperty.call(obj, k)) continue; out[k] = sadDiagPlaceholder_(obj[k]) ? '' : sysStr_(obj[k]); }
  return out;
}
// Run the write path's FIRST gate, read-only, and report the exact token it would raise.
function sadDiagSchemaGate_(ss, table, headers) {
  var res = { table: table, present: false, gate: 'UNKNOWN', safety_token: '', missing_headers: [], header_count: 0 };
  var sheet = null;
  try { sheet = ss.getSheetByName(table); } catch (e) { sheet = null; }
  if (!sheet) { res.gate = 'BLOCKED'; res.safety_token = 'SCHEMA_NOT_PROVISIONED'; res.missing_headers = (headers || []).slice(); return res; }
  res.present = true;
  try { res.header_count = sheet.getLastColumn(); } catch (e2) {}
  // The exact validate-only gate the handler hits first. It throws; it never mutates.
  try {
    prodRequireSheet_(ss, table, headers || []);
    res.gate = 'PASS';
  } catch (gateErr) {
    res.gate = 'BLOCKED';
    var m = sysStr_(gateErr && gateErr.message);
    var tok = m.match(/PRODUCTION_SAFETY:([A-Z_]+)/);
    res.safety_token = tok ? tok[1] : 'SCHEMA_REFUSED';
  }
  // Which canonical headers the live tab does not have (names only — no row content).
  try {
    var lastCol = sheet.getLastColumn();
    var actual = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return sysStr_(h); }) : [];
    var have = {}; actual.forEach(function (h) { have[h] = 1; });
    res.missing_headers = (headers || []).filter(function (h) { return !have[h]; });
  } catch (e3) {}
  return res;
}
// FK readiness — does the id the payload carries exist in its master table? Presence only; no row echo.
function sadDiagIdExists_(ss, table, column, value) {
  if (!sysStr_(value)) return null;   // nothing supplied -> not applicable
  try {
    var sh = ss.getSheetByName(table); if (!sh) return false;
    var d = sh.getDataRange().getValues(); if (d.length < 2) return false;
    var h = d[0].map(function (x) { return sysStr_(x).toLowerCase(); });
    var c = h.indexOf(String(column).toLowerCase()); if (c === -1) return false;
    for (var r = 1; r < d.length; r++) { if (sysStr_(d[r][c]) === sysStr_(value)) return true; }
    return false;
  } catch (e) { return false; }
}

function handleShippingAllocationDraftDiagnostic_(body) {
  var requestId = sysStr_(body && (body.requestId || body.request_id)) || ('SADDIAG-' + Utilities.getUuid().substring(0, 8).toUpperCase());
  var header = sadDiagClean_((body && body.header) || {});
  var line = (body && body.line) ? body.line : null;
  var draftId = sysStr_(body && (body.allocation_draft_id || body.allocationDraftId));
  var out = {
    success: true, request_id: requestId,
    read_only: true, db_writes: 0, drive_writes: 0, status_transitions: 0, emails: 0, demo_mutations: 0,
    api_contract_version: SYS_API_CONTRACT_VERSION_, build_version: SYS_DEPLOYMENT_RELEASE_,
    evaluator: 'production (prodRequireSheet_ + sadHeaderRouteIsComplete_ + sadResolveActiveDraftK2OrK3_ + sadLegacyReconcileReason_)'
  };
  var blockers = [];

  // 1. action + handler availability (probed by symbol, never invoked)
  var router = sysRouterReadiness_();
  // F1-7N-FB-4G-A2-R3 §E.5 — the contract probe must be able to PROVE the atomic writer is reachable, because
  // it is now the only path that creates or edits a route ticket and the client will not fall back.
  var wanted = ['upsertShippingAllocationDraft', 'upsertShippingAllocationDraftLines', 'upsertShippingAllocationDraftAtomic', 'getShippingAllocationDraftWorkspace', 'submitAllocationDraftsToShippingPlans'];
  out.actions = router.actions.filter(function (a) { return wanted.indexOf(a.action) !== -1; });
  out.actions_all_available = out.actions.length === wanted.length && out.actions.every(function (a) { return a.available; });
  if (!out.actions_all_available) blockers.push({ reason: 'ROUTER_ACTION_OR_HANDLER_MISSING', detail: 'a required allocation-draft action is not present in the DEPLOYED code (partial Apps Script sync)' });

  var ss;
  try { ss = SpreadsheetApp.openById(prodExpectedDbId_()); }
  catch (e) {
    out.verdict = 'BLOCKED';
    out.blocking_reasons = [{ reason: 'DB_NOT_REACHABLE', detail: 'the configured production database could not be opened' }];
    return jsonResponse_(out);
  }

  // 2. the write path's first gate, run read-only on BOTH tables
  out.schema_gate = [
    sadDiagSchemaGate_(ss, 'shipping_allocation_drafts', (typeof SHIPPING_ALLOCATION_DRAFTS_HEADERS_ !== 'undefined') ? SHIPPING_ALLOCATION_DRAFTS_HEADERS_ : []),
    sadDiagSchemaGate_(ss, 'shipping_allocation_draft_lines', (typeof SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_ !== 'undefined') ? SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_ : [])
  ];
  out.schema_mode = 'EXACT_LIVE_30_COL_AUTHORITY (C2-D1R; order-sensitive, no additive tolerance in normal runtime)';
  for (var i = 0; i < out.schema_gate.length; i++) {
    var g = out.schema_gate[i];
    if (g.gate !== 'PASS') blockers.push({ reason: 'PRODUCTION_SAFETY:' + (g.safety_token || 'SCHEMA_REFUSED'), detail: g.table + (g.missing_headers.length ? (' — missing header(s): ' + g.missing_headers.join(', ')) : ' — header row does not match the canonical authority in the expected order') });
  }

  // 3. the existing production header-drift evidence report (41_), summarized — never the row content
  if (typeof auditShippingAllocationSchemaReadOnly === 'function') {
    try {
      var audit = auditShippingAllocationSchemaReadOnly();
      out.schema_audit = ((audit && audit.tables) || []).map(function (t) {
        return { table: t.table, exists: t.exists, column_count: t.columnCount, exact_match: t.exactMatch,
          first_mismatch_index: t.firstMismatchIndex, missing_headers: t.missingHeaders || [],
          extra_headers: t.extraHeaders || [], reordered_headers: t.reorderedHeaders || [],
          migration_classification: t.migrationClassification };
      });
      if (audit && audit.error) out.schema_audit_error = sysStr_(audit.error);
    } catch (auditErr) { out.schema_audit_error = 'AUDIT_UNAVAILABLE'; }
  }

  // 4. payload field contract — report what is present/absent; never invent a value
  var routeFields = ['company', 'country', 'marketplace', 'recommended_source_warehouse_id',
    'recommended_destination_warehouse_id', 'destination_marketplace', 'recommended_shipping_method'];
  var present = {}, absent = [];
  routeFields.forEach(function (f) { var v = sysStr_(header[f]); present[f] = v !== ''; if (v === '') absent.push(f); });
  out.payload_field_contract = { supplied: present, absent: absent,
    note: 'destination_marketplace is an ACCEPTED payload field but is NOT a stored column — it makes an Amazon logical destination a valid To.' };

  // 5. route completeness — the REAL predicate
  var routeComplete = (typeof sadHeaderRouteIsComplete_ === 'function') ? sadHeaderRouteIsComplete_(header) : null;
  out.route_complete = routeComplete;
  out.source_destination_readiness = {
    source_warehouse_id: sysStr_(header.recommended_source_warehouse_id) || null,
    source_exists_in_warehouses: sadDiagIdExists_(ss, 'warehouses', 'warehouse_id', header.recommended_source_warehouse_id),
    destination_warehouse_id: sysStr_(header.recommended_destination_warehouse_id) || null,
    destination_exists_in_warehouses: sadDiagIdExists_(ss, 'warehouses', 'warehouse_id', header.recommended_destination_warehouse_id),
    destination_is_logical_marketplace: sysStr_(header.destination_marketplace) !== '',
    shipping_method: sysStr_(header.recommended_shipping_method) || null
  };
  if (routeComplete === false) blockers.push({ reason: 'PLAN_HEADER_INCOMPLETE', detail: 'a Draft route requires From + To + Method (an Amazon logical destination counts as To); a partial route is refused with zero rows written' });
  if (out.source_destination_readiness.source_exists_in_warehouses === false) blockers.push({ reason: 'FK_SOURCE_WAREHOUSE_NOT_FOUND', detail: 'the supplied source warehouse_id is not present in warehouses' });
  if (out.source_destination_readiness.destination_exists_in_warehouses === false) blockers.push({ reason: 'FK_DESTINATION_WAREHOUSE_NOT_FOUND', detail: 'the supplied destination warehouse_id is not present in warehouses' });

  // 6. identity / idempotency / INSERT-vs-UPDATE — the REAL resolution authority
  out.pk_readiness = { deterministic: false, expected_allocation_draft_id: null, basis: null };
  out.idempotency = { keyed_by: 'the deterministic K2 shipment-group hash of the header route dims (sadK2DeterministicHeaderId_), so a retry UPDATES the same row instead of inserting a duplicate', resolution: null };
  var dsh = null;
  try { dsh = ss.getSheetByName('shipping_allocation_drafts'); } catch (e4) { dsh = null; }
  if (dsh && typeof sadResolveActiveDraftK2OrK3_ === 'function') {
    try {
      if (draftId && !sadDiagPlaceholder_(draftId)) {
        // explicit id path — the same guard the handler applies before editing an existing row
        var found = (typeof procurementFindRow_ === 'function') ? procurementFindRow_(dsh, 'allocation_draft_id', draftId) : null;
        out.pk_readiness = { deterministic: true, expected_allocation_draft_id: draftId, basis: 'explicit allocation_draft_id supplied by the caller' };
        out.expected_classification = found ? 'UPDATE' : 'INSERT';
        out.idempotency.resolution = found ? 'EXISTING_ROW' : 'ID_NOT_FOUND';
        if (found && typeof sadLegacyReconcileReason_ === 'function') {
          // FB-4A §D — pass the REQUEST header so this reports the same semantic-group verdict production takes.
          var legR = sadLegacyReconcileReason_(dsh, found, false, header);
          out.reconcile_guard = legR || 'PASS';
          if (legR) blockers.push({ reason: legR, detail: (typeof sadReconcileMessage_ === 'function') ? sadReconcileMessage_(legR) : 'requires an explicit user migration' });
        }
      } else {
        var res = sadResolveActiveDraftK2OrK3_(dsh, header, { allowLegacyReconcile: false });
        out.idempotency.resolution = res.status + (res.k2 ? ' (K2 shipment group)' : ' (K3 scope)');
        if (res.status === 'CREATE' || res.status === 'REUSE') {
          out.pk_readiness = { deterministic: true, expected_allocation_draft_id: sysStr_(res.id) || null,
            basis: res.k2 ? 'deterministic K2 shipment-group hash of the header route dims' : 'existing active draft for this scope' };
          out.expected_classification = (res.status === 'CREATE') ? 'INSERT' : 'UPDATE';
        } else if (res.status === 'CONFLICT') {
          out.expected_classification = 'BLOCKED';
          blockers.push({ reason: 'BLOCKED_CONFLICT', detail: 'more than one active Draft for this ' + (res.k2 ? 'shipment group (K2)' : 'scope (K3)') + '; resolve manually (zero rows written)' });
        } else {
          out.expected_classification = 'BLOCKED';
          blockers.push({ reason: sysStr_(res.reason) || 'BLOCK', detail: 'the real draft-resolution authority refuses this payload with zero rows written' });
        }
      }
    } catch (resErr) {
      out.idempotency.resolution = 'EVALUATION_FAILED';
      blockers.push({ reason: 'DRAFT_RESOLUTION_EVALUATION_FAILED', detail: 'the resolver could not be evaluated against the live table' });
    }
  }

  // 7. line quantity / date validity — the REAL predicates
  if (line && (sysStr_(line.sku) || Number(line.planned_qty) > 0)) {
    var lineOk = (typeof sadLineIsComplete_ === 'function') ? sadLineIsComplete_(line) : null;
    var canonDate = (typeof sadCanonDate_ === 'function' && sysStr_(line.required_by_date)) ? sadCanonDate_(line.required_by_date) : '';
    out.line_readiness = { sku_present: sysStr_(line.sku) !== '', planned_qty: Number(line.planned_qty) || 0,
      complete: lineOk, required_by_date_canonical: canonDate || null,
      // sadCanonDate_ echoes an unparseable value back unchanged, so validity is the canonical SHAPE, not
      // merely a non-empty return.
      date_valid: sysStr_(line.required_by_date) === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(canonDate) };
    if (lineOk === false) blockers.push({ reason: 'PLAN_LINE_INCOMPLETE', detail: 'a persistable line needs a SKU and a quantity greater than zero' });
    if (out.line_readiness.date_valid === false) blockers.push({ reason: 'LINE_DATE_NOT_CANONICAL', detail: 'required_by_date is not canonicalizable to YYYY-MM-DD' });
  }

  // 8. the exact rows a successful save WOULD write — a manifest, not a write
  out.expected_write_manifest = (blockers.length)
    ? [{ table: '(none)', operation: 'ZERO_WRITE', rows: 'every reason above is a pre-write refusal — no cell would be touched' }]
    : [
      { table: 'shipping_allocation_drafts', operation: out.expected_classification || 'INSERT_OR_UPDATE', rows: 'exactly one header row, keyed by the deterministic allocation_draft_id above' },
      { table: 'shipping_allocation_draft_lines', operation: 'UPSERT_BY_LINE_ID', rows: 'one row per COMPLETE Execution Plan line; recommendation-snapshot columns are preserved when the payload omits them' }
    ];
  out.blocking_reasons = blockers;
  out.verdict = blockers.length ? 'BLOCKED' : 'READY';
  out.exact_blocking_reason = blockers.length ? (blockers[0].reason + ' — ' + (blockers[0].detail || '')) : '';
  return jsonResponse_(out);
}

function TEMP_SHIPPING_ALLOCATION_DRAFT_DIAGNOSE() {
  var hdr = sadDiagClean_(TEMP_SAD_DIAGNOSTIC_HEADER_);
  var did = sadDiagPlaceholder_(TEMP_SAD_DIAGNOSTIC_ALLOCATION_DRAFT_ID_) ? '' : sysStr_(TEMP_SAD_DIAGNOSTIC_ALLOCATION_DRAFT_ID_);
  var d = {};
  try {
    d = JSON.parse(handleShippingAllocationDraftDiagnostic_({
      header: hdr, line: TEMP_SAD_DIAGNOSTIC_LINE_, allocation_draft_id: did
    }).getContent());
  } catch (e) { Logger.log('[SAD-DIAG] UNPARSEABLE'); return; }

  Logger.log('[SAD-DIAG] verdict=' + d.verdict + ' | exact_blocking_reason=' + (d.exact_blocking_reason || '(none)'));
  Logger.log('[SAD-DIAG] evaluator=' + d.evaluator);
  Logger.log('[SAD-DIAG] actions_all_available=' + d.actions_all_available);
  (d.actions || []).forEach(function (a) { Logger.log('[SAD-DIAG][action] ' + a.action + ' available=' + a.available); });
  (d.schema_gate || []).forEach(function (g) {
    Logger.log('[SAD-DIAG][schema-gate] ' + g.table + ' present=' + g.present + ' gate=' + g.gate +
      ' token=' + (g.safety_token || '-') + ' header_count=' + g.header_count +
      ' missing=[' + (g.missing_headers || []).join(',') + ']');
  });
  Logger.log('[SAD-DIAG] schema_mode=' + d.schema_mode);
  (d.schema_audit || []).forEach(function (t) {
    Logger.log('[SAD-DIAG][header-drift] ' + t.table + ' exists=' + t.exists + ' cols=' + t.column_count +
      ' exact=' + t.exact_match + ' first_mismatch_index=' + t.first_mismatch_index +
      ' missing=[' + (t.missing_headers || []).join(',') + '] extra=[' + (t.extra_headers || []).join(',') +
      '] reordered=[' + (t.reordered_headers || []).join(',') + '] classification=' + t.migration_classification);
  });
  if (d.schema_audit_error) Logger.log('[SAD-DIAG][header-drift] error=' + d.schema_audit_error);
  Logger.log('[SAD-DIAG] payload absent_fields=[' + ((d.payload_field_contract && d.payload_field_contract.absent) || []).join(',') + ']');
  Logger.log('[SAD-DIAG] route_complete=' + d.route_complete);
  var sd = d.source_destination_readiness || {};
  Logger.log('[SAD-DIAG] from=' + sd.source_warehouse_id + ' fk_ok=' + sd.source_exists_in_warehouses +
    ' | to=' + sd.destination_warehouse_id + ' fk_ok=' + sd.destination_exists_in_warehouses +
    ' logical_marketplace_to=' + sd.destination_is_logical_marketplace + ' | method=' + sd.shipping_method);
  var pk = d.pk_readiness || {};
  Logger.log('[SAD-DIAG] pk_deterministic=' + pk.deterministic + ' expected_id=' + pk.expected_allocation_draft_id + ' basis=' + pk.basis);
  Logger.log('[SAD-DIAG] idempotency=' + ((d.idempotency && d.idempotency.resolution) || '-') + ' expected_classification=' + d.expected_classification);
  if (d.reconcile_guard) Logger.log('[SAD-DIAG] reconcile_guard=' + d.reconcile_guard);
  if (d.line_readiness) Logger.log('[SAD-DIAG] line complete=' + d.line_readiness.complete + ' qty=' + d.line_readiness.planned_qty +
    ' date_canonical=' + d.line_readiness.required_by_date_canonical + ' date_valid=' + d.line_readiness.date_valid);
  (d.expected_write_manifest || []).forEach(function (m) { Logger.log('[SAD-DIAG][would-write] ' + m.table + ' ' + m.operation + ' — ' + m.rows); });
  (d.blocking_reasons || []).forEach(function (b) { Logger.log('[SAD-DIAG][blocker] ' + b.reason + ' — ' + (b.detail || '')); });
  Logger.log('[SAD-DIAG] request_id=' + d.request_id);
  Logger.log('READ_ONLY = ' + d.read_only);
  Logger.log('DB_WRITES = ' + d.db_writes);
  Logger.log('DRIVE_WRITES = ' + d.drive_writes);
  Logger.log('STATUS_TRANSITIONS = ' + d.status_transitions);
  Logger.log('EMAILS = ' + d.emails);
  Logger.log('DEMO_MUTATIONS = ' + d.demo_mutations);
}
