# Controlled no-action activation runbook — F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R3

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

## Three things worth understanding before starting

**A baseline a readback recomputes cannot detect a change.** Whatever it finds becomes what it expected. So the
BEFORE state is frozen into a constant **by a person**, from the manifest's own printed block, and
`RUN_R6R7_CONTROLLED_NO_ACTION_READBACK()` refuses to run against an unfrozen one. That refusal is the feature.

**A mutation request is not a database write.** The browser transport will record exactly **one** mutation
request, because the operator asked the server to consider generating. The server's answer is that nothing
needed writing. `mutation_requests: 1` beside `db_writes: 0` is the **correct** shape of a no-action. Reading
the first number as the second would roll back a correct finish.

**The two halves are measured in different places and must stay there.** Apps Script cannot see the browser and
the browser cannot see the database. The readback states the rows; the snippet states the requests. Neither
invents the other's number.

---

## Before: authorize

Run `RUN_R6R7_CONTROLLED_NO_ACTION_ACTIVATION_MANIFEST()` and read the `r6r7_proof` line.

It must say `READY_TO_AUTHORIZE`. It refuses on any of these:

- the deployment build is not `F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R2`, is mixed, has stale modules, or cannot be read
- the flag is already `true`, or the allowlist is not exactly the one scope
- the recommendation is not READY, not current, or any window is not a stored finite `0`
- `recommended_qty ≠ 0`, `residual_qty ≠ 0`, or the manual planned total ≠ 520
- Route A is not at version 4, Route B is not at version 3, either quantity or last mile has moved, or either
  row has been adopted by a run
- an active AI row already exists for the scope
- `production_path.outcome` is not `AI_PLAN_NO_ACTION`, `would_write` is not `false`, or `parity.agree` is not `true`
- any writer or mutation counter is non-zero

Then **paste its `freeze_paste_block` into `R6R7_NO_ACTION_BEFORE_`** in the census file and re-sync that file.
Until you do, the readback will STOP with `BASELINE_NOT_FROZEN` and name every field it is missing.

---

## The twelve steps

1. Set `INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_` to `true` in `00_config.gs`. One constant. Do not touch the allowlist.
2. Sync **only** `00_config.gs` (and `63_api_v1_system_health.gs` if its release id moved).
3. Publish a **new Web App deployment version**. Saving the editor does not change what the Web App answers.
4. Hard refresh the page.
5. Verify: deployment contract OK, `mixed_deployment false`, the **effective** flag `true`, and the allowlist still exactly one scope.
6. Run `RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT()` again. The flag is now true, so this is a different state from every earlier preflight.
7. Only if it still says `READY_NO_ACTION`: run the **baseline snippet**, then press **Generate AI Plan once** through the normal UI.
8. Do **not** press it a second time. A replay is verified by reading, never by pressing.
9. Do **not** press Submit Plan.
10. Run the **delta snippet**, then `RUN_R6R7_CONTROLLED_NO_ACTION_READBACK()` immediately.
11. Set the flag back to `false`, sync `00_config.gs`, publish a deployment version.
12. Verify the effective flag is `false` again and the deployment contract is still OK.

Re-running the manifest is itself the step-12 check: it STOPs while the flag is `true`.

---

## Browser snippets

Both are printed by the manifest under `browser_audit`. Run them in the page console.

**Baseline — before the click.** Records the highest request seq the page has already reached, so the delta
counts only what this test caused.

**Delta — after exactly one click.** Reports `new_mutation_requests`, `generation_requests`,
`exactly_one_generation_request`, any `unexpected_mutations`, and for the generation request its
`request_id`, `phase`, `outcome`, `attempts`, `overlapped_with`, `routes_in_payload` and allocation ids.

It reports `scope_reported_by_transport: null` on purpose — the transport records the action and the rows, not
the business scope. Record the scope from the station selector you used. A scope invented there would be a
guess.

If the baseline was never taken, the delta refuses with `NO_BASELINE` and tells you not to press Generate
again.

**Required delta:** `mutation_requests 1`, action `weeklyAiPlan.generate`, route saves 0, submits 0,
reservations 0, second generation requests 0.

---

## After: read back

`RUN_R6R7_CONTROLLED_NO_ACTION_READBACK()` must say `CONTROLLED_NO_ACTION_CONFIRMED`. It proves, against the
frozen baseline:

- Route A and Route B are **byte-identical** by fingerprint, and their versions, `updated_at` and
  `line_updated_at` have not moved
- neither was re-owned by a run
- no header and no line was created; the AI row count did not increase; nothing was expired by a run
- the manual planned total is still 520, and the same header and line ids contribute it
- no reservation appeared
- the readback itself wrote nothing

The server response must independently read `AI_PLAN_NO_ACTION` / `NO_REPLENISHMENT_REQUIRED`,
`recommended_qty 0`, `qualifying_planned_qty 520`, `residual_qty 0`, every created / updated / cancelled
counter `0`, `db_writes 0`, `writer_reached false`, `routes []`, `groups []`. The response is what the server
says it did; the rows are what it actually did. They must agree.

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
