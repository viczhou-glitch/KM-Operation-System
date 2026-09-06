# Controlled no-action activation runbook — F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R3 · P1

The first time this system is allowed to write an AI Plan, the correct outcome is that it writes nothing.

That is not a rehearsal. `ResUS / US / Amazon / CO1100-R` has a READY recommendation holding a stored, finite
`0` in every window and an active manual plan of 520 units. The residual is 0, so a generation has nothing to
add. Pressing Generate once and proving that **nothing moved** is the safest possible first exercise of the
write path, and it is the only one where a mistake is visible immediately against a frozen baseline.

Nothing in this document has been executed. The flag is `false`, no deployment was published, no generation was
called, and production writes are 0.

---

## The scope, frozen

| | |
|---|---|
| company | `ResUS` |
| country | `US` |
| marketplace | `Amazon` |
| sku | `CO1100-R` |

The allowlist must hold **exactly this one entry**. A blank in any of the four axes is a wildcard; a
marketplace-only, company-only or `ALL_SITES` entry widens the blast radius and the manifest refuses to
authorize while one exists.

---

## Five things worth understanding before starting

**A baseline a readback recomputes cannot detect a change.** Whatever it finds becomes what it expected. So the
BEFORE state is frozen into a constant **by a person**, from the manifest's own printed block, and
`RUN_R6R7_CONTROLLED_NO_ACTION_READBACK()` refuses to run against an unfrozen one. That refusal is the feature.

**"Byte-identical" means every column, or it means nothing.** The live tables carry **36** header columns and
**31** line columns. R3 froze eighteen fields, so a generation that touched `create_idempotency_key`,
`formula_version`, `source_data_as_of` or `expected_arrival` would have moved a row while every fingerprint
stayed equal. The freeze now covers **all 67 columns per route**, in the order 16_'s own schema constants give,
and a column the live sheet cannot supply is a **STOP** rather than a footnote.

**Two rows are not the whole scope.** A header created and immediately cancelled, a row soft-deleted, an old
terminal draft adopted by the new run — every one of those leaves the two active routes untouched and is still
a write. So the freeze also covers **every** header matching the scope at **any** status, every line under
those headers, and the header-to-line relation between them.

**A mutation request is not a database write.** The browser transport will record exactly **one** mutation
request, because the operator asked the server to consider generating. The server's answer is that nothing
needed writing. `mutation_requests: 1` beside `db_writes: 0` is the **correct** shape of a no-action. Reading
the first number as the second would roll back a correct finish.

**Three things are measured in three places, and none stands in for another.** Apps Script cannot see the
browser and the browser cannot see the database:

| | measured where | what it is |
|---|---|---|
| `expected_production_decision` | Apps Script | what 61_'s builder says the server *should* answer |
| `actual_browser_response` | the browser | the reply the page actually received — pasted in by a person |
| `database_observed_after` | Apps Script | the rows |

A confirmation needs all three. **A timeline phase of `SUCCESS` is not a response body**, and a recomputed
decision is not a received reply.

---

## The order, and why it is this order

The freeze and the baseline check come **before** the authorization. An authorization given while the baseline
is still null authorizes a click that nothing can check afterwards.

### Phase PREPARE — read-only

1. Run `RUN_R6R7_CONTROLLED_NO_ACTION_ACTIVATION_MANIFEST()` and read the `r6r7_proof` line. It must say
   `READY_TO_AUTHORIZE`.
2. Copy the `freeze_paste_block` — emitted as `r6r7_freeze_paste_block_1_of_N` … `N_of_N`, before the detailed
   export — into `R6R7_NO_ACTION_BEFORE_` in the census file. It carries the full-row field maps, not only the
   fingerprints: a fingerprint says a row moved, the field maps say **which column** did.
3. Re-sync **only** the census file. No production file changes to freeze a baseline.
4. Run `RUN_R6R7_CONTROLLED_NO_ACTION_READBACK()` as a baseline check. Expect **`AWAITING_ACTIVATION`** with
   `baseline_frozen: true`. `BASELINE_NOT_FROZEN` here means step 2 did not take.

### Phase AUTHORIZE

5. **STOP.** Obtain an explicit authorization to flip the flag. Everything before this point is read-only.
   Nothing after it is.

### Phase ACTIVATE

6. Set `INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_` to `true` in `00_config.gs`. One constant. Do not touch the
   allowlist.
7. Sync **only** `00_config.gs`, publish a **new Web App deployment version**, hard refresh. Saving the editor
   does not change what the Web App answers.
8. Verify the deployment contract OK, `mixed_deployment false`, the **effective** flag `true`, and the
   allowlist still exactly one scope; then run `RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT()` again and require
   `READY_NO_ACTION`. The flag is now true, so this is a different state from every earlier preflight.

### Phase PRESS

9. Run the browser **baseline** snippet, then the single-use **response capture** snippet. Both before the
   click.
10. Press **Generate AI Plan once** through the normal UI. Do **not** press Submit Plan.

### Phase READ

11. Run the browser **audit** snippet and copy its `paste_block` into `R6R7_ACTUAL_BROWSER_RESPONSE_` in the
    census, then re-sync the census. Without it the readback answers `AWAITING_BROWSER_AUDIT`.
12. Run `RUN_R6R7_CONTROLLED_NO_ACTION_READBACK()` and require `CONTROLLED_NO_ACTION_CONFIRMED`.

### Phase RESTORE

13. Set the flag back to `false`, sync `00_config.gs`, publish a deployment version.
14. Verify the effective flag is `false` again and the deployment contract is still OK. **Re-running the
    manifest IS this check**: it STOPs while the flag is `true`.

---

## Before: what the manifest refuses on

`READY_TO_AUTHORIZE` requires every one of these; any single failure is a STOP that names itself.

- the deployment build is not `F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R2`, is mixed, has stale modules, or **cannot be
  read** — not being able to ask is not the same as the answer being yes
- the flag is already `true`, or the allowlist is not exactly the one scope, or any axis is blank
- the header schema is not a generation 16_ enumerates, is not 36 columns, or its column **names** do not match
  the authority byte for byte — and the same three for the 31-column line
- any of the four full-row snapshots covers fewer than its canonical columns, or **excludes** one
- the identity universe cannot be read, or an active AI header already exists in it
- the reservation table is `SHEET_PRESENT_BUT_UNREADABLE`, or absent **without** 61_'s structural guarantee
- the project's own normalizers (`sadFpNorm_`, `sadAuditNormCell_`, `sadFpVal_`) are not all reachable
- the recommendation is not READY, not current, or any window is not a stored finite `0`
- `recommended_qty ≠ 0`, `residual_qty ≠ 0`, or the manual planned total ≠ 520
- Route A is not at version 4, Route B is not at version 3, either quantity or last mile has moved, or either
  row has been adopted by a run
- `production_path.outcome` is not `AI_PLAN_NO_ACTION`, `would_write` is not `false`, or `parity.agree` is not
  `true`
- any writer or mutation counter is non-zero

---

## The full-row freeze

Each route is frozen as **four** snapshots — Route A header, Route A line, Route B header, Route B line — each
covering every canonical column of its table, and each carrying a fingerprint:

| | |
|---|---|
| `header_full_fingerprint` | all 36 header columns |
| `line_full_fingerprint` | all 31 line columns |
| `combined_full_fingerprint` | the pair — this is what "the route did not move" means |
| `route_a_fingerprint` (route view) | the 18 fields of the **page's projection**. Kept, and **no longer the byte-identical claim** |

**The column order comes from the schema authority**, `SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_` and
`SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_` in `16_shipping_allocation_handlers.gs` — never from
`Object.keys` of a row, because key order on an object read out of a sheet is an accident of which cells were
non-blank, and a fingerprint over an accidental order is not reproducible.

**The schema itself is frozen alongside the rows** — version, column count and a fingerprint over the column
names, for both tables. A snapshot compared across an added, dropped or renamed column is comparing two
different tables.

**Comparison is representation-robust, using the project's existing normalizers and no new one.** A calendar
date and a numeric go through `sadFpNorm_` (16_); everything else goes through `sadAuditNormCell_` (41_), which
reduces a `Date` to its epoch, so a timezone display string cannot read as a change. A second timestamp parser
would eventually disagree with the first, and the one that disagrees silently is the one holding the evidence.

---

## Browser snippets

All four are printed by the manifest under `browser_audit`. Run them in the page console.

**Baseline — before the click.** Records the highest request seq the page has already reached, so the delta
counts only what this test caused.

**Capture — before the click, after the baseline.** Wraps `KM.DB.generateWeeklyAiPlanDraft` and nothing else.
It forwards `this` and `arguments` untouched, adds no request, captures at most once, and reads a **whitelist**
of fields out of the envelope so no token, header or full payload leaves with it. A **second** call is
*rejected and announced* rather than sent — a silent second click is an unexplained row. The wrapper stays
armed until the audit snippet releases it, and a timeout releases it too, so the page is never left patched.

**Audit — after exactly one click.** Releases the capture, then merges three things: the transport **delta**,
the **captured response**, and the **capture state**. It prints a `paste_block` to copy into
`R6R7_ACTUAL_BROWSER_RESPONSE_`.

- `response_body_inferred_from_timeline: false` — with no capture the verdict is `ACTUAL_RESPONSE_NOT_CAPTURED`
  no matter how clean the timeline looks.
- `scope_reported_by_transport: null` on purpose — the transport records the action and the rows, not the
  business scope. Record the scope from the station selector you used; a scope invented there would be a guess.
- With no baseline the delta refuses with `NO_BASELINE` and tells you **not** to press Generate again.

**Required delta:** `mutation_requests 1`, action `weeklyAiPlan.generate`, route saves 0, submits 0,
reservations 0, second generation requests 0.

---

## After: the readback's five answers

| verdict | what it means |
|---|---|
| `BASELINE_NOT_FROZEN` | step 2 was not done. Every missing field is named. |
| `AWAITING_ACTIVATION` | baseline frozen, database identical, flag still off. The expected step-4 answer. |
| `AWAITING_BROWSER_AUDIT` | database identical, but nobody pasted the browser audit. **Unknown is not confirmed.** |
| `ACTUAL_RESPONSE_NOT_CAPTURED` | the audit was pasted and reports no response body. Treat as case B. |
| `CONTROLLED_NO_ACTION_CONFIRMED` | all three objects present and agreeing, and nothing moved. |
| `STOP` | something moved, or the response and the rows disagree. Named predicate by named predicate. |

`CONTROLLED_NO_ACTION_CONFIRMED` proves, against the frozen baseline:

- both routes **byte-identical across all 67 canonical columns**, by fingerprint *and* field by field —
  `changed_fields` is computed every time, not only when a fingerprint disagrees
- the schema version, column count and column names of both tables are unmoved
- neither route was re-owned by a run; no header and no line was created
- **no id appeared or vanished at any status**, and the header-to-line relation is unchanged
- **no status, `line_status`, `generation_type`, `generation_run_id` or `draft_version` moved anywhere in the
  scope** — including on rows the active view never shows
- the manual planned total is still 520, contributed by the same header and line ids
- no reservation appeared, under a **named observation state**
- the actual browser response reads `AI_PLAN_NO_ACTION` / `NO_REPLENISHMENT_REQUIRED`, `0 / 520 / 0`, every
  created / updated / cancelled counter `0`, `db_writes 0`, `writer_reached false`, no routes and no groups
- the response and the rows **agree**, and the response and the expected decision agree
- the readback itself wrote nothing

### The reservation observation contract

| state | verdict |
|---|---|
| `SHEET_PRESENT_AND_READABLE` | scoped ids, count and a **per-row fingerprint over every column** are frozen and compared. A row changed in place is caught where a count would not be. |
| `SHEET_ABSENT` | acceptable **only** with 61_'s own activation manifest listing `reservations` among the tables a generation cannot mutate. The `authority` field says which leg answered. |
| `SHEET_PRESENT_BUT_UNREADABLE` | **STOP.** The table is there and will not open, so neither a count nor a structural guarantee describes what is in it. |

`null === null` never carries this claim. A count we could not read is not a count of zero.

---

## Rollback

**A — the no-action happened as expected.** No data rollback: nothing was written, so there is no row to
expire, no version to restore and no total to correct. Still required: flag back to `false`, publish a
deployment version, re-verify the effective flag and the deployment contract.

**B — anything was written, or the outcome is unknown or timed out.**

1. **Do not press Generate again.** A retry is a guess about what happened, and a guess that writes turns one
   unexplained row into two.
2. Run the readback. The database is the only authority on what happened.
3. Freeze every new or changed `allocation_draft_id` / `allocation_draft_line_id`, with their fields.
4. Produce a repair manifest: what moved, what it was, what it should be, and which single write fixes it.
5. Set the flag back to `false` and publish a deployment version **immediately**, before any repair.
6. Obtain a separate, explicit authorization before changing any data.

Never edit the sheet by hand, never delete a row, never repair from the page. A change with no recorded reason
is indistinguishable from data loss. A timeout is case B until the readback says otherwise: a proven zero-write
stays retryable, anything else is decided by reading.
