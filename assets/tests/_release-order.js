// SHARED RELEASE ORDER — F1-7N-FB-4E-R4B-R3.
//
// NOT a test. Four suites each kept their own hand-copied list of release tokens and their own regex for a
// build stamp, and every round had to append the same line to all of them — which is why four suites failed
// R4B-R3 for a reason that had nothing to do with what they test. A list maintained in four places is not a
// contract; it is four chances to disagree. The order lives here once.
//
// APPEND-ONLY. A round adds its token at the END. Nothing is ever removed or reordered: the whole point of the
// list is that "at or after round X" is answerable, and rewriting history would make an older suite's floor
// mean something different than it did when it was written.
'use strict';

var ROUND_TOKENS = [
  'donenotice-20260811',
  'fb4e-transport-20260826',
  'fb4c-scope-registry-20260826',
  'fb4er1-contract-probe-20260827',
  'fb4er2-action-registry-20260827',
  'fb4er3-lifecycle-20260827',
  'fb4er4a-correlation-20260827',
  'fb4er4a1-readtransport-20260827',
  'fb4er4b-readback-20260831',
  'fb4er4br1-authority-20260831',
  'fb4er4br2-hydrationjoin-20260831',
  'fb4er4br3-liveclosure-20260831',
  // F1-7N-SKU-DETAILS-DISPLAY-INIT-R1 - SKU Details Display column initialization. sku-details.js changed, and
  // it sits in BOTH co-deployed sets the FB-4D and FB-4E suites police, so the whole application set rotates
  // together. A token that moves for one member and not the others can still ship a half-updated page.
  'skudisplayinit-20260901',
  // F1-7N-FB-4F-B6 - Legacy route explicit confirmation + hydration repair. inventory-replenishment.js and
  // inventory-compat.js both changed, and they are co-deployed with the API/transport files in this same set:
  // a page that hydrates a persisted destination against an api layer from a different round is exactly the
  // half-updated deployment the shared token exists to make impossible.
  'fb4fb6-legacyroute-20260901',
  // F1-7N-FB-4F-B6-R1 - Expected Arrival structured-value closure. A NEW token rather than a reuse of B6's,
  // and the reason is a fact rather than a preference: B6 is already on origin/main (its commit 60afa6e was
  // pushed), so its bytes have left the repository and any build serving them has handed browsers
  // `?v=fb4fb6-legacyroute-20260901`. Reusing that token would leave every one of those browsers on the B6
  // copy of inventory-replenishment.js forever, which is precisely the half-updated deployment the shared
  // token exists to prevent. A token may only be reused while nothing carrying it has been published.
  'fb4fb6r1-etasnapshot-20260901',
  // F1-7N-FB-4G-A0 - CO1100-R live hydration closure. B6-R1 is on origin/main (82da01c was pushed), so by the
  // rule recorded above its token has been published and cannot be reused. This round changes the SOURCE the
  // Execution Plan hydrate reads, so a browser left on the previous copy would keep reading a cache the server
  // never fills and would keep showing a default editor for a route that exists in the database.
  'fb4ga0-livehydration-20260902',
  // F1-7N-FB-4G-A0-R1 - destination XOR + persisted method selection. A0 is on origin/main (60e5ef3 was
  // pushed), so by the rule above its token has been published and cannot be reused. This round changes both
  // inventory-replenishment.js and inventory-compat.js, and a browser holding one file from each round would
  // have a page whose Method picker calls an identity helper the shared module does not yet export.
  'fb4ga0r1-destxor-20260902',
  // F1-7N-FB-4G-A0-R2 - server canonical destination completeness. A0-R1 is on origin/main (1f91d3b was
  // pushed), so by the rule above its token has been published. This round changes CLIENT code, not just
  // tests: isRouteComplete, routeHeaderFields and the page gates all stopped accepting a route that carries
  // two contradictory destinations, so a browser left on the old copy would keep sending one.
  'fb4ga0r2-destauthority-20260902',
  // F1-7N-FB-4G-A1 - Recommendation Summary + Execution Plan atomic reveal. A0-R2 is on origin/main
  // (6b49320 was pushed), so by the rule above its token has been published and cannot be reused. This
  // round changes inventory-replenishment.js and inventory-compat.js together: the page now asks a reveal
  // owner that only the shared module exports, so a browser holding one file from each round would expand a
  // SKU into a decision area that never leaves its skeleton.
  'fb4ga1-atomicreveal-20260902',
  // F1-7N-FB-4G-A1-R1 - panel-local planning readiness + the duplicate workspace read removed. A1 is on
  // origin/main (c9517ec was pushed), so by the rule above its token has been published and cannot be
  // reused. This round changes inventory-replenishment.js, inventory-compat.js AND core/method-registry.js
  // together: the page seeds the registry through a method the previous registry copy does not have, and a
  // browser holding any one of the three from the older round would either issue the duplicate workspace
  // read again or fail to seed at all.
  'fb4ga1r1-panelready-20260902',
  // F1-7N-FB-4G-A2 - Submit Plan preflight, one dirty owner and a confirmation. A1-R1 is on origin/main
  // (418971a was pushed), so by the rule above its token has been published and cannot be reused. This round
  // changes inventory-replenishment.js and inventory-compat.js together: the page asks a preflight owner that
  // only the shared module exports, so a browser holding one file from each round would either lose the
  // unsaved-change guard or lose the confirmation that precedes every submit request.
  'fb4ga2-submitpreflight-20260902',
  // F1-7N-FB-4G-A2-R1 + A2-R2 ship as ONE frontend release. A2-R1 rewrote the Submit chain so it never saves,
  // and A2-R2 rewrote how a route write declares itself (intent, stable route instance identity, event-scoped
  // persistence). inventory-replenishment.js and inventory-compat.js change together in both: the page sends an
  // intent only the shared module's payload builder emits, and asks a preflight owner only that module exports.
  // A browser holding one file from each round would either save a route with no declared intent - which the
  // A2-R2 server refuses with zero writes - or lose the confirmation that precedes every submit request.
  'fb4ga2r2-routeintent-20260902',
  // F1-7N-FB-4G-A2-R3. Three browser files move together and none of them works with an older sibling:
  // inventory-replenishment.js now issues ONE atomic route write, operation-system-db-api.js is where that
  // action's adapter lives (there was none before, so the page could not call it at all), and
  // inventory-compat.js emits the intent + create_idempotency_key the atomic writer requires. A browser
  // holding a mixed set would either call an adapter that does not exist, or send a create with no
  // idempotency key - which the A2-R3 server refuses with zero writes.
  'fb4ga2r3-atomicroute-20260902',
  // F1-7N-FB-4G-A2-R3-R1. The A2-R3 client could not acknowledge the atomic writer's own success envelope,
  // so every route save reported OUTCOME UNKNOWN while the row was in fact written, and the version it
  // failed to adopt made every later edit STALE_OPTIMISTIC_TOKEN. The page, the transport adapter and 16_
  // move together: an older page against this server still cannot read the header classification.
  'fb4ga2r3r1-savefix-20260903',
  // F1-7N-FB-4G-A2-R4. The Execution Plan collector and the transport adapter move together: an older page
  // still erases a route's identity the moment an edit leaves it briefly incomplete, and an older adapter
  // still pins a symbol that now lives in a different file.
  'fb4ga2r4-stableentity-20260903',
  // F1-7N-FB-4G-A3. The Submit preflight and its one pure predicate move together: an older page still
  // lets a visibly incomplete route be dropped from the plan in silence, and an older predicate cannot
  // count the Weekly Shipping Plans the confirmation now promises.
  'fb4ga3-submitreadiness-20260903',
  // F1-7N-FC-1A. The page and the adapter move together, and this token is the reason the page must not be
  // served from cache after this round: an older page shows an approved plan with no Shipment Draft as a
  // perfectly healthy card and offers no way to recover it, and an older adapter turns
  // INSUFFICIENT_FACTORY_STOCK into HTTP_TRANSPORT_ERROR by throwing a business rejection.
  // SUPERSEDED BY F1-7N-FC-1A-R1-HF1 — the five lines that follow are WRONG, and they are kept
  // because the reason they were wrong is the whole point of this series. The correction is recorded below.
  // F1-7N-FC-1A-R1 deliberately does NOT add a token. FC-1A and R1 are ONE atomic release (R1 §0): FC-1A
  // acquires factory stock reservations and R1 provides the only routed way to release one, so a deployment
  // carrying FC-1A alone can strand units. Minting a second token would let the two halves be cached, shipped
  // and reasoned about separately, which is exactly what the release decision forbids. The FC-1A token covers
  // both, and the ACTION-CONTRACT version (10 -> 11) is what actually refuses a half-synced deployment.
  'fc1a-shipmentrecovery-20260903',
  // F1-7N-FC-1A-R1-HF1 — THE CORRECTION, and it is a correction of REASONING, not of a typo.
  //
  // R1 argued: FC-1A and R1 are ONE atomic release, so minting a second token would let the two halves be
  // cached and shipped separately. The premise is true and the conclusion does not follow, because ATOMICITY
  // and CACHE IDENTITY are different axes enforced by different mechanisms. What holds the release together is
  // the ACTION-CONTRACT version (10 -> 11), which refuses a half-synced deployment outright. A cache token does
  // not hold a release together; it decides one thing only — whether a browser refetches a file. Reusing
  // FC-1A's therefore bought no atomicity at all, and cost the single thing a token exists to buy.
  //
  // It also broke the rule this file already states in its own words, ten entries up: "A token may only be
  // reused while nothing carrying it has been published." FC-1A WAS published — d94d5bd was pushed —
  // so browsers had already been handed `?v=fc1a-shipmentrecovery-20260903`. Reusing it meant every one of them
  // would keep the FC-1A copy of shipping-history.js, which R1 CHANGED, for the life of that cache entry: a
  // Shipment Draft card with no Cancel button, against a server that has cancelShipmentDraft routed and
  // waiting. The reservation would stay held with no reachable way to release it — which is the exact
  // hazard R1 §0 was written to close, reintroduced by the decision meant to honour it.
  //
  // shipping-plan.js was worse, and reuse is not even what happened to it. FC-1A rewrote that file — the
  // recovery banner, the Retry action, the contract gate — and never moved its token off
  // `donenotice-20260811`, dated 2026-08-11. The one file carrying the whole recovery feature had no cache
  // identity for that feature at all, and no assertion covered it because the round measured the token it had
  // moved rather than the files it had changed. HF1 moves the ENTIRE application set onto one new token, so no
  // member of it can be served from an older round than any other.
  'fc1ar1-cancelrelease-20260903',
  // F1-7N-FC-1B-E1 — Execution Plan explicit intent. HF1 is on origin/main (b39bfc5 was pushed), so by the
  // rule recorded above its token has been published and cannot be reused. This round changes
  // inventory-replenishment.js and inventory-compat.js TOGETHER and they do not work as a mixed pair: the page
  // now refuses to render an execution route that cannot name which explicit act produced it, and the owner of
  // that vocabulary — IRRouteProvenance — lives in the shared module. A browser holding the new page with the
  // old module would find window.IRRouteProvenance undefined; holding the old page with the new module would
  // keep seeding a blank Suggested-Qty route that the new Submit preflight then refuses as
  // ROUTE_PROVENANCE_UNKNOWN — a plan the operator cannot submit and cannot see the cause of.
  'fc1b-executionintent-20260903',
  // F1-7N-FC-1B-E2 — Manual Route Composer + AI Plan outcome visibility. E1 is on origin/main (ad39806 was
  // pushed), so by the rule recorded above its token has been published and cannot be reused. This round
  // changes inventory-replenishment.js and inventory-compat.js TOGETHER and a mixed pair is broken in both
  // directions: the page renders a composer whose three states only the shared module can name, and the
  // module's Submit preflight refuses a route shape the old page still produces. A browser holding one file
  // from each round would either paint a row nothing can classify or be unable to submit a finished route.
  'fc1b-e2-aiplancomposer-20260903',
  // F1-7N-FC-1B-E3 — AI Plan controlled activation + visible runtime feedback + Execution row layout.
  // E2 is on origin/main (200a6fa was pushed), so by the rule recorded above its token has been published and
  // cannot be reused. THREE reasons a browser must refetch, and the first is the one that matters most:
  //   1. THE STYLESHEET. `.replen-ai-plan-result` had no rule anywhere in the repository, which is why every
  //      sentence Site Inventory's AI Support has ever tried to say was laid out at the bottom of an
  //      `overflow: hidden` body and was literally unreachable. A browser holding the cached CSS would keep
  //      showing nothing while the new page believes it has spoken — the exact defect this round fixes.
  //   2. THE LAYOUT CONTRACT. The Execution Plan control box moved from `.exec-route-row`-scoped rules to the
  //      shared `.ir-exec-plan__grid`. Old CSS + new page = a composer with no control styling at all (the
  //      reported misalignment); new CSS + old page = header labels inset for a grid whose padding the old
  //      page's cached rules still shrink.
  //   3. THE PAGE AND THE SHARED MODULE, together as always: the page can now report an unreconciled AI Plan
  //      run and only the new inventory-compat.js knows EXECUTION_PLAN_AI_UNRECONCILED, so an old module would
  //      let a plan be submitted whose stored shape nobody has established.
  'fc1b-e3-aiplanactive-20260903',
  // F1-7N-FC-1B-E3-R1 — canonical harvest readiness diagnosis + typed refusal. E3 is on origin/main
  // (e6749b5 was pushed), so by the rule recorded above its token has been published and cannot be reused.
  // ONE browser asset changed and it is the page: inventory-replenishment.js learns to READ the typed readiness
  // answer the server has always been able to give. The reason it must refetch is precise — the classifier
  // was looking for `res.errors` (plural) on a command result that carries `res.error` (singular), so a browser
  // holding the cached page will keep reporting "AI Plan could not complete — FAILED" with an empty
  // Technical details panel no matter how completely the server names its refusal. The stylesheet did NOT change
  // this round and stays on its own family's current token.
  'fc1b-e3r1-readiness-20260903',
  // F1-7N-FC-1B-E3-R2 — manual-composer expected-state UX. E3-R1 is on origin/main (951d58c was pushed),
  // so its token is published and cannot be reused. THREE browser assets change and each one is independently
  // necessary, which is what makes this rotation load-bearing rather than routine:
  //   1. inventory-compat.js gains IRRouteUiState, the SEVEN-state lifecycle vocabulary. It is the authority
  //      the page asks "is this row a failure or an unfinished edit", and an old cached module answers
  //      `undefined` — which the page's conservative fallback reads as a non-failure, so a REAL refusal
  //      could be rendered as a neutral hint. That is the new defect this rotation prevents, and it is worse
  //      than the one being fixed.
  //   2. inventory-replenishment.js routes the incomplete-route notice to the neutral surface and refuses a
  //      NEUTRAL envelope at the door of the failure renderer. A browser on the cached page keeps showing
  //      "Unsaved — database update failed" with Technical details and "Retryable: yes" for a composer
  //      that issued no request at all.
  //   3. inventory-replenishment.css declares `.ir-route-hint` for the FIRST time, so a cached stylesheet
  //      leaves the new sentence unstyled — the exact failure class E3 found in `.replen-ai-plan-result`.
  //      The stylesheet therefore ALSO rotates in its own family below; both are required.
  'fc1b-e3r2-composerstate-20260903',
  // F1-7N-FC-1B-E3-R3-R1 — missing forecast means zero + the AI Plan unblock. R2 is published
  // (origin/main carries 4979903), so its token cannot be reused. ONE browser asset changes and its
  // refetch is not cosmetic: inventory-replenishment.js gains `_irReadStageReport_`, the per-stage
  // measurement for the RECURRING first-attempt timeout. A browser on the cached page has no such
  // function, so the next occurrence would be observed with nothing to observe it — which is how
  // this defect stayed 'NOT REPRODUCED' for three rounds. The stylesheet did NOT change and stays on
  // its own family's current token.
  'fc1b-e3r3r1-forecastzero-20260904',
  // F1-7N-FC-1B-E3-R4 — the first-load timeout fix and the execution demand snapshot SSOT. R3-R1 is
  // PUBLISHED (origin/main carries 6c9594f), so its token cannot be reused. The refetch is load-bearing in
  // both directions:
  //   1. inventory-replenishment.js now asks the workspace for `recentWindow`. A browser on the cached page
  //      keeps sending the old unbounded request, so the very defect this round fixes would still be observed
  //      after a deployment that fixed it — the worst possible outcome for a timeout investigation.
  //   2. It also gains _irExpectedDemandFromSnapshot_, which declares the snapshot the operator is looking at.
  //      A cached page sends no expectation, and a mid-flight re-materialization goes back to being silent.
  // The stylesheet did NOT change this round and stays on its own family's current token.
  'fc1b-e3r4-scopedread-20260904',
  // F1-7N-FC-1B-E3-R4-A1 — R4 is PUBLISHED (origin/main carries 3b44cbd), so its token cannot be reused, and
  // the refetch is load-bearing for two browser files. km-api-foundation.js now carries `recentWindow` and
  // `only` through the DTO — R4 shipped a page that asked for a projection the DTO silently dropped, so a
  // cached foundation keeps sending the pre-R4 request while the new page believes it asked. And
  // inventory-replenishment.js carries the rebuilt stage report: a cached page keeps the action-to-stage map
  // that classified one live request in four and then printed a root cause anyway.
  'fc1be3r4a1-livecontract-20260904',
  // F1-7N-FC-1B-E3-R4-A2-R1 — R4-A1 is PUBLISHED (origin/main carries 6266169), so its token cannot be
  // reused, and the refetch is load-bearing: operation-system-db-api.js gains the capability sequence guard. A
  // cached copy still lets a 45-second failure resolve late and overwrite a later success with fail-safe
  // defaults — silently flipping the runtime posture minutes after the page looked settled, which is a
  // worse failure than the one it was meant to protect against.
  'fc1be3r4a2r1-schedaware-20260904',
  'fc1be3r4a2r1r3-transport-20260904',
  // F1-7N-FC-1B-E3-R4-A2-R1-R4 - live carrier authority, lifecycle schema parity, allocation completeness.
  // R3 is on origin/main (e4b87d9 was pushed), so by the rule above its token has been published and cannot be
  // reused. This round changes core/supply-planning-weekly-route-derivation.js, which is co-deployed with the
  // rest of the shared planning core: the plan object gains `completeness` (three separate verdicts) and each
  // group gains `route_evidence`, and a browser holding one copy from each round would read `conserved` as a
  // completion property again and print a blank arrival date beside a resolved route.
  'fc1be3r4a2r1r4-completeness-20260904',
  // F1-7N-FC-1B-E3-R4-A2-R1-R6 - confirmed transit buffer, quantity-axis split, advice UI contract.
  // R5 minted NO token: nothing it changed reached a browser. R6 does - pages/inventory-replenishment.js
  // learns a THIRD generation outcome and reads `data.advice`. A browser holding the R5 copy would keep
  // telling an operator that a run which produced a complete 760-unit recommendation found no eligible
  // route and that nothing supports a shipment - the exact sentence this round exists to stop, served
  // from cache against a server that is already sending the recommendation.
  'fc1be3r4a2r1r6-advicecontract-20260905',
  // F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 - live UI scope identity, manual method authority, advice/plan reconciliation.
  // pages/inventory-replenishment.js changes on the path the LIVE button actually takes: the hydrate stops
  // adopting another company's stored route, the Method dropdown resolves from carrier_lead_times, the arrival
  // becomes the conservative one, and the hundred-SKU notice stops leading with an internal reason code. A
  // browser holding the R6 copy keeps every one of those, and the first of them is a cross-company Execution
  // Plan - which is the one defect on this page that can reach Submit.
  'fc1be3r4a2r1r6r1-scopeidentity-20260905',
  'fc1be3r4a2r1r6r2-routeparity-20260905',
  'fc1be3r4a2r1r6r3-etaalign-20260905',
  // R6-R4: the Last Mile becomes a real column with a real control, the Execution Plan reconciliation stops
  // reading a map only the AI Plan button fills, and the arrival's method-profile selection is delegated to
  // the registry. A browser holding the R6-R3 copy is served a page that renders six cells into a seven-track
  // grid - every column after Method lands one place to the left, and the row that asks for a last mile still
  // has nowhere to answer it.
  'fc1be3r4a2r1r6r4-lastmilecol-20260905',
  // R6-R5: the cold-boot read arbitration. A browser holding the R6-R4 copy dispatches the primary workspace
  // read alongside the boot reads again, so an immediate navigation after a hard reload spends part of the
  // read's own 60s budget queueing behind requests the table does not need — which is the reported timeout.
  'fc1be3r4a2r1r6r5-coldboot-20260905',
  // R6-R6: the Execution Plan reconciliation becomes three numbers instead of five lines of prose, and a
  // route whose write outcome cannot be classified is HELD out of the write scope instead of being re-sent by
  // the next unrelated edit. A browser holding the R6-R5 copy keeps both old behaviours — the paragraph the
  // operator asked to have removed, and a blind second write after an ambiguous ACK — and the second of those
  // is a correctness defect, not a cosmetic one.
  'fc1be3r4a2r1r6r6-compactrecon-20260905',
  // R6-R6-R2: single-row mutation isolation. A browser holding the R6-R6 copy still writes a route the
  // operator never touched: a lane with exactly one eligible last mile fills the cell in, that derived value
  // lands in the same DOM field the collector reads as intent, and the next edit on ANY row on the card
  // carries it to the database as though a person had chosen it. This is the round that separates a derived
  // display value from an authored one, so it is the token that must move — a stale copy of this page is a
  // page that writes rows nobody asked it to.
  'fc1be3r4a2r1r6r6r2-rowisolation-20260906',
  // F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4 - the controlled single-row Save audit. R6-R6-R3 moved NO frontend file
  // and correctly reused R6-R6-R2's token; this round changes operation-system-db-api.js and km-transport.js,
  // which are co-deployed, so a NEW token is required. R6-R6-R2's has been published (a4f18f9 is on
  // origin/main), and a published token may never be reused: every browser holding it would keep the copy of
  // the api layer that cannot report an intent, which is exactly the audit this round exists to perform.
  'fc1be3r4a2r1r6r6r4-mutationaudit-20260906'
];

// The newest entry is the current APPLICATION token, by construction rather than by restatement - the same
// treatment currentMapToken() already gives the map series, and for the same reason. Four suites had pinned the
// literal `fb4er4br3-liveclosure-20260831` with a count of 18; every one of them meant "a MAP round must not
// move the application token", and every one of them would have failed the first time an APPLICATION round
// legitimately moved it. That is the equality-with-now this file exists to end.
function currentAppToken() { return ROUND_TOKENS[ROUND_TOKENS.length - 1]; }

// ---------------------------------------------------------------------------------------------------------
// THE MAP TOKEN SERIES — added in TEXTURE-3-R6, and the reason is the same failure one round later.
//
// R5 replaced "the co-deployed map set shares ONE token" with a DERIVED rule: a map file whose source carries
// this round's marker must carry this round's token, and one that does not must not. That rule was right, and
// it still rotted immediately — because "this round" was written into three suites as the literal strings
// `TEXTURE-3-R5` and `map-texture3-r5-20260831`. The moment R6 rotated two files, all three suites failed while
// describing the correct state.
//
// A rule that has to be edited in three places every round is the four-way duplication this file was created to
// end, wearing a different hat. So the series lives here, APPEND-ONLY, and the current round is DERIVED from its
// last entry — including the source marker, which is reconstructed from the token rather than restated. A round
// now appends ONE line here and nothing else moves.
// ---------------------------------------------------------------------------------------------------------
var MAP_TOKEN_SERIES = [
  'map-zh-hant-20260826',
  'map-texture3-r2-20260826',
  'map-texture3-r3-20260826',
  'map-texture3-r4-20260827',
  'map-texture3-r5-20260831',
  'map-texture3-r6-20260831',
  'map-texture3-r8-20260831',
  'map-labelmode-r9-20260831',
  'map-labelcopy-r9a-20260831'
];

// The newest entry is the current round's token, by construction rather than by restatement.
function currentMapToken() { return MAP_TOKEN_SERIES[MAP_TOKEN_SERIES.length - 1]; }

// ---------------------------------------------------------------------------------------------------------
// THE MAP BROWSER FILE INVENTORY — added in TEXTURE-3-R8, and the reason is the R6 lesson one level further in.
//
// R6 moved "which round is current" here because three suites each kept their own copy and all three broke the
// moment a round rotated a file. That worked. What R6 left behind was the OTHER half of the same rule: the SET
// of files the rule applies to was still a hand-maintained list inside each suite.
//
// R8 is the first round to change a map browser file that was in neither list — global-logistics-map.js, the
// page that owns the lazy ADM1 loader. The derived rule then reported, correctly and uselessly, that no map
// file carried this round's marker: 3 assertions across 2 suites failed while describing a true state, because
// the inventory they measured was incomplete rather than because anything was wrong.
//
// So the inventory lives here as well. A round that touches a map browser file now appends nothing at all; a
// round that introduces one appends ONE line here and no suite changes.
// ---------------------------------------------------------------------------------------------------------
// TEXTURE-3-R9 — the map page's STYLESHEET joins the inventory. R8 added the page because R8 was the round that
// changed it; R9 is the round that changes its CSS, and a stylesheet a browser caches is exactly as capable of
// serving a stale segmented control as a script is of serving stale behaviour.
var MAP_BROWSER_FILES = [
  'assets/js/data/geo-names-zh-hant.js',
  'assets/js/data/geo-display-aliases-zh-tw.js',
  'assets/js/data/geo-admin1-display-names-zh-tw.js',
  'assets/js/core/geo-name-resolver.js',
  'assets/js/lib/km-geo-topology.js',
  'assets/js/lib/km-globe.js',
  'assets/js/pages/global-logistics-map.js',
  'assets/css/pages/global-logistics-map.css'
];

// The in-source marker that identifies work done in a given round, derived FROM the token so the two cannot
// disagree: 'map-texture3-r6-20260831' -> 'TEXTURE-3-R6'. The pre-texture3 tokens have no marker of this shape,
// which is correct — they predate the convention — and return ''.
//
// TEXTURE-3-R9 — THE FAMILY SEGMENT IS NOT THE MARKER. This pattern was pinned to the literal `texture3`, and
// R9's token is `map-labelmode-r9-20260831` — a different family on the same round series. The old pattern
// returned '' for it, and an EMPTY marker is worse than a wrong one: every caller does
// `new RegExp(currentMapRoundMarker())`, and `new RegExp('')` matches every file, so every map file would have
// been judged "changed this round" and required to carry the R9 token. A rule that silently becomes universal is
// the failure mode this derivation exists to prevent, so the family is now any segment and the ROUND is what is
// captured. The marker prefix stays TEXTURE-3 because that is the line these rounds belong to, whatever a given
// round's token is named after.
//
// The empty case is still reachable for a genuinely pre-convention token, so callers that build a RegExp from it
// must not be handed ''. currentMapRoundMarkerRe() below is the guarded way to ask.
function mapRoundMarker(token) {
  var m = /^map-[a-z0-9]+-(r\d+[a-z]?\d*)-/.exec(String(token || ''));
  return m ? ('TEXTURE-3-' + m[1].toUpperCase()) : '';
}
function currentMapRoundMarker() { return mapRoundMarker(currentMapToken()); }
// The guarded form. Returns a RegExp that matches the current round's marker, or — if the current token carries
// no derivable round — one that matches NOTHING, rather than the everything-matching /(?:)/ that `new RegExp('')`
// would hand back. A suite asking "did this file change this round?" must get 'no' from a broken derivation, not
// 'yes' for every file in the tree.
function currentMapRoundMarkerRe() {
  var m = currentMapRoundMarker();
  return m ? new RegExp(m) : /(?!)/;
}
function isMapToken(t) { return MAP_TOKEN_SERIES.indexOf(String(t)) !== -1; }

// ---------------------------------------------------------------------------------------------------------
// F1-7N-FC-1B-E3 — THE SITE INVENTORY STYLESHEET SERIES.
//
// `assets/css/pages/inventory-replenishment.css` is deliberately NOT in the application series: three suites
// assert that the two families are never crossed, one of them by checking the token's SHAPE. What the family
// did not have was a ledger, so "which round is current" lived as a literal inside one suite — the same
// thing the map series was given a ledger for, and with the same result: the first round to legitimately
// rotate the stylesheet broke that suite while describing a correct tree.
//
// Append-only. A round that changes the stylesheet adds one line here.
var IR_CSS_TOKEN_SERIES = [
  // F1-7N-FB-4G-A1-R1 — panel-local readiness; the round that established the separate family.
  'irpanelready-20260902',
  // F1-7N-FC-1B-E3 — the Execution Plan layout contract (one control box for the header row, a persisted
  // route, an AI route and both composers) plus the FIRST stylesheet rules `.replen-ai-plan-result` has ever
  // had. That second half is the round's own defect: the class was copied from Order Planning's
  // `.ro-ai-plan-result` without its stylesheet, so every sentence Site Inventory's AI Support tried to say
  // was laid out at the bottom of an `overflow: hidden` body and could not be reached even by scrolling. A
  // browser serving the cached stylesheet would keep showing nothing while the new page believed it had
  // spoken, which is why this rotation is not cosmetic.
  'irexecrow-20260903',
  // F1-7N-FC-1B-E3-R2 — `.ir-route-hint`, the amber one-line surface for an edit in progress. The rule is
  // NEW, so a browser serving the cached stylesheet renders the sentence with no rule at all: no background, no
  // border, and inheriting whatever the card gives it. That is precisely how `.replen-ai-plan-result` came to
  // be invisible for two rounds, so the family rotates rather than trusting the page's rotation to cover it.
  'irroutehint-20260903',
  // R6-R1 - `.ir-scope-company`, `.ir-plan-recon` and `.replen-card__method-cell`. All three rules are NEW, so
  // a browser serving the cached stylesheet renders the company badge as bare text, the advice/plan
  // reconciliation as three spans running together, and stacks nothing in the Method cell. The reconciliation
  // is the one that matters: its whole job is to stop 760 and 520 being read as one number, and an unstyled
  // run-together version does the opposite.
  'irscopecompany-20260905',
  'iretaalign-20260905',
  // R6-R4: seven tracks, and a Last Mile cell that must be styled to clip inside its own track. A cached
  // six-track stylesheet puts every column after Method out of register with its heading.
  'irlastmilecol-20260905',
  // R6-R6: the reconciliation strip stops wrapping and loses its box and its full-width note; the flag that
  // replaces the note is a NEW rule. A cached six-rule copy renders the compact markup with no flag styling
  // and with the old wrapping box, which is the paragraph's footprint without the paragraph's content.
  'ircompactrecon-20260905'
];
// F1-7N-FC-1B-E3-R4-A1 — method-registry.js HAS ITS OWN TOKEN FAMILY, AND IT HAD NO LEDGER.
//
// The file rotates on its own cadence (it is not an application-series asset), and every round that touched it
// asserted its literal token as "the current one". That is the same defect this file was built to end for the
// application and map series, and it broke the same way the first time the file changed again: A1-R1's round
// wrote `method-registry.js?v=fb4ga1r1-method-registry-20260902` into an assertion about the PRESENT, and R4-A1
// rotating it turned that into an assertion about the past.
//
// A series with an index makes the durable claim checkable: each round's token is a FLOOR, and the file's
// current token is a member of the family rather than of the application series.
var METHOD_REGISTRY_TOKEN_SERIES = [
  'fb4c-method-registry-20260826',
  'fb4ga1r1-method-registry-20260902',
  // R4-A1: the carrier catalogue stops asking for all twenty-one tables and names the two it reads. A cached
  // copy keeps issuing the full read, which is the cost this round removed.
  'fc1be3r4a1-method-registry-20260904',
  // R6-R1: the registry stops treating a PRICE LIST as the authority on whether a shipping method exists. It
  // already loaded carrier_lead_times and never read them; it now derives service profiles from them when no
  // rate card covers the lane. A cached copy keeps answering 'No eligible method' for every route whose lane
  // has transit data and no price - which is the reported defect itself.
  'fc1be3r4a2r1r6r1-method-registry-20260905',
  // R6-R4: resolve() now attaches the transit authority's last-mile facts to every method option, whichever
  // table named it. A cached copy keeps returning rate-card options that know nothing about a last mile, so
  // the row cannot offer the choice the arrival calculator is asking for.
  'fc1be3r4a2r1r6r4-method-registry-20260905'
];
var METHOD_REGISTRY_FILE = 'assets/js/core/method-registry.js';
function currentMethodRegistryToken() { return METHOD_REGISTRY_TOKEN_SERIES[METHOD_REGISTRY_TOKEN_SERIES.length - 1]; }
function methodRegistryTokenIndex(t) { return METHOD_REGISTRY_TOKEN_SERIES.indexOf(String(t)); }
function methodRegistryTokenAtOrAfter(t, floorToken) {
  var i = methodRegistryTokenIndex(t), f = methodRegistryTokenIndex(floorToken);
  return i !== -1 && f !== -1 && i >= f;
}
var IR_CSS_FILE = 'assets/css/pages/inventory-replenishment.css';
function currentIrCssToken() { return IR_CSS_TOKEN_SERIES[IR_CSS_TOKEN_SERIES.length - 1]; }
function isIrCssToken(t) { return IR_CSS_TOKEN_SERIES.indexOf(String(t)) !== -1; }
function irCssTokenIndex(t) { return IR_CSS_TOKEN_SERIES.indexOf(String(t)); }
function irCssTokenAtOrAfter(t, floorToken) {
  var i = irCssTokenIndex(t), f = irCssTokenIndex(floorToken);
  return i !== -1 && f !== -1 && i >= f;
}
function mapTokenIndex(t) { return MAP_TOKEN_SERIES.indexOf(String(t)); }
// THE FLOOR COMPARISON, and the reason a round's suite needs it. Four rounds running, a round's own suite has
// asserted "this file carries MY token" as an equality — and then the next round legitimately moved the file
// and the assertion failed while describing a correct state. R5 broke R4's, R6 broke R5's, R8 broke R6's, R9
// broke R6's and R8's.
//
// The durable statement is not an equality with "now". It is a FLOOR: a file whose content moved in round N must
// never be served from a token OLDER than N. That still catches the defect the equality was written for — a
// round that changed a file and forgot to rotate it — and it stays true forever afterwards, because later rounds
// only ever move the token forward.
function mapTokenAtOrAfter(t, floorToken) {
  var i = mapTokenIndex(t), f = mapTokenIndex(floorToken);
  return i !== -1 && f !== -1 && i >= f;
}
// index.html versions BOTH <script src> and <link href>, and until R9 every consumer of this file parsed only
// the script tags — written out separately in each suite. R9 puts a stylesheet under the same token discipline,
// so the parser becomes shared rather than copied a third time.
function parseIndexTokens(indexHtml) {
  var out = {}, m;
  var reScript = /<script[^>]*\ssrc="([^"?]+)(?:\?v=([^"]*))?"/g;
  while ((m = reScript.exec(String(indexHtml)))) { if (!(m[1] in out)) out[m[1]] = m[2] === undefined ? null : m[2]; }
  var reLink = /<link[^>]*\shref="([^"?]+)(?:\?v=([^"]*))?"/g;
  while ((m = reLink.exec(String(indexHtml)))) { if (!(m[1] in out)) out[m[1]] = m[2] === undefined ? null : m[2]; }
  return out;
}

// F1-7N-FC-1A-R1-HF1 — THE PINNED COUNT OF 18, which is the equality-with-now this file exists to end,
// surviving one field to the left of where it was fixed. Three suites asserted that index.html carries the
// current application token exactly 18 times. The comment above one of them says, in as many words, that the
// literal TOKEN was replaced by currentAppToken() because a literal "also forbade any APPLICATION round from
// moving it" — and then left the literal COUNT standing, which forbids any application round from changing
// how many assets it covers. HF1 is that round: it moves 19 assets, so all three failed while describing a
// correct tree, and a fourth used `app === 18` as a MUTATION BASELINE, where a dirty baseline silently converts
// every CAUGHT result into a meaningless one.
//
// What those assertions are FOR is that a MAP round must not rotate the application set, and an application
// round must not rotate the map set. That is answerable from the inventory this file already keeps, without a
// number: a map browser file must carry a map-series token, and everything else must not. Adding an asset, or
// moving the whole application set forward, cannot make it false; putting the map token on an application asset
// — the thing N7 mutates — cannot make it true.
function misplacedIndexTokens(indexHtml) {
  var toks = parseIndexTokens(indexHtml), out = [], p;
  for (p in toks) {
    if (!Object.prototype.hasOwnProperty.call(toks, p)) continue;
    if (toks[p] === null) continue;                       // unversioned: a different rule's business
    var isMapFile = MAP_BROWSER_FILES.indexOf(p) !== -1;
    if (isMapFile && !isMapToken(toks[p])) out.push(p + ' is a map browser file but carries ' + toks[p]);
    if (!isMapFile && isMapToken(toks[p])) out.push(p + ' is an application asset but carries the map token ' + toks[p]);
    // F1-7N-FC-1B-E3 — the third family, checked in both directions like the other two. The Site
    // Inventory stylesheet must carry an IR-CSS token, and nothing else may.
    if (p === IR_CSS_FILE && !isIrCssToken(toks[p])) out.push(p + ' is the Site Inventory stylesheet but carries ' + toks[p]);
    if (p !== IR_CSS_FILE && isIrCssToken(toks[p])) out.push(p + ' is not the Site Inventory stylesheet but carries the IR-CSS token ' + toks[p]);
  }
  return out;
}
// THE CO-DEPLOYED SET ROTATED TOGETHER, said without a number. Eleven suites asserted this as "the current
// application token appears in index.html exactly 18 times", and all eleven failed the moment a round
// legitimately covered a nineteenth asset — the same equality-with-now, in the one field the previous
// restatement did not reach.
//
// What "rotated together" MEANS is that no member of the set was left behind on the round it is moving off.
// That is answerable from this series: an entry whose token is a KNOWN APPLICATION token which is neither the
// current one nor the ORIGINAL BASELINE is a half-updated deployment, whoever left it there. The baseline is
// exempt because a file sitting on it is a file no application round has ever needed to rotate, which is a
// legitimate state for 46 of them; a file that DID change and was not rotated is a different defect, and it is
// caught where it is answerable — against the feature's own symbols, not against a token count.
//
// Adding an asset cannot break this. Leaving one behind cannot satisfy it.
function staleAppTokenRefs(indexHtml) {
  var toks = parseIndexTokens(indexHtml), cur = currentAppToken(), base = ROUND_TOKENS[0], out = [], p;
  for (p in toks) {
    if (!Object.prototype.hasOwnProperty.call(toks, p)) continue;
    var t = toks[p];
    if (t === null || t === cur || t === base) continue;
    if (tokenIndex(t) !== -1) out.push(p + ' is left behind on ' + t);
  }
  return out;
}
// How many index.html entries carry the current application token. Reported, never pinned: a round that adds an
// asset moves this number, and that is not a defect.
function appTokenRefCount(indexHtml) {
  var toks = parseIndexTokens(indexHtml), n = 0, cur = currentAppToken(), p;
  for (p in toks) {
    if (Object.prototype.hasOwnProperty.call(toks, p) && toks[p] === cur) n++;
  }
  return n;
}
// The CANONICAL SHAPE of an Apps Script owner build stamp. The project stamps revisions of revisions
// (F1-7N-FB-4E-R4B-R3 is the third revision of the second revision of round 4E), so the revision segment
// repeats. A pattern that admitted only ONE revision segment rejected a legitimate stamp the moment a round
// needed a second one — which is exactly what happened in R4B-R3.
// F1-7N-FC-1B-E3 — the revision segment is -R<n> OR -E<n>. The FC-1B rounds revise as E1/E2/E3 (already
// the shape of three entries in ROUND_TOKENS above), and this regex admitted only the -R form, so the first
// backend owner file to declare an E-series stamp was reported as carrying no real build stamp at all by every
// suite that validates through here. The vocabulary is fixed in the one place that owns it.
// F1-7N-FC-1B-E3-R4-A1 — the A-SERIES was missing, and it had been missing all along.
//
// The vocabulary admitted -R<n> and -E<n> only, so it rejected FOUR stamps this project has actually shipped:
// F1-7N-FB-4G-A0-R1, F1-7N-FB-4G-A1-R1, F1-7N-FB-4G-A2-R3-R1 and now F1-7N-FC-1B-E3-R4-A1. Three of those sit
// in OWNER_STAMPS below, so the file simultaneously recorded them as real and would have called them malformed
// — the gap only stayed invisible because no suite happened to validate one of them through here. An
// A-series round is an addendum to a shipped round, which is exactly what this one is.
// F1-7N-FC-1B-E3-R4-A2-R1-R1 — and the B-SERIES was missing too, for the same reason and with the same
// symptom: F1-7N-FB-4F-B1, -B3 and -B6 all sit in OWNER_STAMPS below as shipped rounds, and all three
// failed this pattern. Found while validating this round's own stamp through here, which is the first
// time anything checked the WHOLE list rather than one entry. A standing assertion now checks all of them.
var BUILD_STAMP_RE = /^F1-7N-[A-Z]+-\d+[A-Z](?:-(?:R\d+[A-Z]?\d*|E\d+|A\d+|B\d+))*$/;

// F1-7N-FB-4G-A0-R1 — THE 16_ OWNER-STAMP ORDER, and it lives HERE because it was living in four places.
// B3, B4, B5 and FB-4F-A each carried their own copy of this array to answer "is the allocation owner build at
// or after round X". A0-R1 moved the stamp and broke all four in one step — the exact failure a duplicated
// constant exists to produce. Append-only; a round that moves SAD_BUILD_VERSION_ adds one line here and
// nowhere else.
var OWNER_STAMPS = ['F1-7N-FB-4D', 'F1-7N-FB-4F-B1', 'F1-7N-FB-4F-B3', 'F1-7N-FB-4F-B6', 'F1-7N-FB-4G-A0-R1', 'F1-7N-FB-4G-A0-R2', 'F1-7N-FB-4G-A2', 'F1-7N-FB-4G-A2-R2', 'F1-7N-FB-4G-A2-R3', 'F1-7N-FB-4G-A2-R3-R1', 'F1-7N-FB-4G-A2-R4', 'F1-7N-FB-4G-A3', 'F1-7N-FC-0A', 'F1-7N-FC-1A', 'F1-7N-FC-1A-R1', 'F1-7N-FC-1B-E3', 'F1-7N-FC-1B-E3-R1', 'F1-7N-FC-1B-E3-R2', 'F1-7N-FC-1B-E3-R3-R1', 'F1-7N-FC-1B-E3-R4', 'F1-7N-FC-1B-E3-R4-A1', 'F1-7N-FC-1B-E3-R4-A2-R1', 'F1-7N-FC-1B-E3-R4-A2-R1-R1', 'F1-7N-FC-1B-E3-R4-A2-R1-R2', 'F1-7N-FC-1B-E3-R4-A2-R1-R3', 'F1-7N-FC-1B-E3-R4-A2-R1-R4', 'F1-7N-FC-1B-E3-R4-A2-R1-R5', 'F1-7N-FC-1B-E3-R4-A2-R1-R6', 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R1', 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R2', 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R3', 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R4', 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R5', 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6', 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R1', 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R1-B1', 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R2', 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R3', 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4'];
// True when `stamp` is a known owner stamp at or after `floor` in that order.
function stampAtOrAfter(stamp, floor) {
  var i = OWNER_STAMPS.indexOf(String(stamp)), f = OWNER_STAMPS.indexOf(String(floor));
  return i !== -1 && f !== -1 && i >= f;
}

// Index of a token in the release order; -1 when unknown (a typo, or a token that was never released).
function tokenIndex(t) { return ROUND_TOKENS.indexOf(String(t)); }
// True when `t` is a known token at or after `floorToken` in the release order.
function tokenAtOrAfter(t, floorToken) {
  var i = tokenIndex(t), f = tokenIndex(floorToken);
  return i !== -1 && f !== -1 && i >= f;
}

module.exports = {
  ROUND_TOKENS: ROUND_TOKENS,
  MAP_TOKEN_SERIES: MAP_TOKEN_SERIES,
  MAP_BROWSER_FILES: MAP_BROWSER_FILES,
  currentAppToken: currentAppToken,
  currentMapToken: currentMapToken,
  currentMapRoundMarker: currentMapRoundMarker,
  currentMapRoundMarkerRe: currentMapRoundMarkerRe,
  mapRoundMarker: mapRoundMarker,
  isMapToken: isMapToken,
  mapTokenIndex: mapTokenIndex,
  mapTokenAtOrAfter: mapTokenAtOrAfter,
  IR_CSS_TOKEN_SERIES: IR_CSS_TOKEN_SERIES,
  IR_CSS_FILE: IR_CSS_FILE,
  currentIrCssToken: currentIrCssToken,
  isIrCssToken: isIrCssToken,
  irCssTokenIndex: irCssTokenIndex,
  irCssTokenAtOrAfter: irCssTokenAtOrAfter,
  parseIndexTokens: parseIndexTokens,
  misplacedIndexTokens: misplacedIndexTokens,
  appTokenRefCount: appTokenRefCount,
  staleAppTokenRefs: staleAppTokenRefs,
  METHOD_REGISTRY_FILE: METHOD_REGISTRY_FILE,
  METHOD_REGISTRY_TOKEN_SERIES: METHOD_REGISTRY_TOKEN_SERIES,
  currentMethodRegistryToken: currentMethodRegistryToken,
  methodRegistryTokenIndex: methodRegistryTokenIndex,
  methodRegistryTokenAtOrAfter: methodRegistryTokenAtOrAfter,
  BUILD_STAMP_RE: BUILD_STAMP_RE,
  tokenIndex: tokenIndex,
  tokenAtOrAfter: tokenAtOrAfter,
  OWNER_STAMPS: OWNER_STAMPS,
  stampAtOrAfter: stampAtOrAfter
};
