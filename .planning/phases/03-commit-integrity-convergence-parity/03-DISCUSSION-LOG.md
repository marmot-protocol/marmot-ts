# Phase 3: Commit Integrity & Convergence Parity - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-29
**Phase:** 3-commit-integrity-convergence-parity
**Areas discussed:** Component integrity (WIRE-03), Admin/leaf coupling (CONV-01), Removal & withdrawal (CONV-02+03), CONV-04 verify-first scope

---

## Pending Todo Cross-Reference

| Option           | Description                                                                                                                                                                                            | Selected |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Fold it in       | `groupsmanager-rejectedevents-dos` from `02-REVIEW.md`, front-matter `resolves_phase: 3` — drop the unbounded `rejectedEvents` Set, filter only on `!seen.has(event.id)`, loosen two exact-count tests | ✓        |
| Leave it pending | Keep Phase 3 purely on WIRE-03/CONV-01..04                                                                                                                                                             |          |

**User's choice:** Fold it in
**Notes:** Only one todo matched (score 0.2). It was already tagged for this phase and is small and self-contained.

---

## Component integrity (WIRE-03)

### Q1 — Where should the validator live, and what shape?

| Option                            | Description                                                                                                                                                                                                                             | Selected |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Pure fn in `src/core/components/` | New `integrity.ts` exporting `validateAppComponentIntegrity({ currentExtensions, resultingExtensions, appDataUpdateOps, requiredIds })`; matches "core = protocol logic, zero I/O", unit-testable, Phase 4 harness can call it directly | ✓        |
| Engine module (mirror MDK)        | `src/engine/component-integrity.ts` operating on ClientState/staged-commit types, mirroring `cgka-engine/src/app_components.rs` 1:1                                                                                                     |          |
| You decide                        | Claude picks during planning                                                                                                                                                                                                            |          |

**User's choice:** Pure fn in `src/core/components/`
**Notes:** MDK keeps it inside `cgka-engine`, but MDK has no core/engine split — so the placement diverges deliberately while the algorithm is ported faithfully.

### Q2 — How should a SEND-path violation surface?

| Option                      | Description                                                                                                             | Selected |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| Throw before publish        | Throw (e.g. `UsageError`) from the staging step; `SendResult` unchanged; matches "throw for domain/validation failures" | ✓        |
| Typed refusal in SendResult | Widen `SendResult<TEnvelope>` with a `{ kind: 'rejected'; reason }` variant                                             |          |
| You decide                  | Claude picks during planning                                                                                            |          |

**User's choice:** Throw before publish
**Notes:** A locally-built violating commit is a programming error, not an expected outcome. Avoids forcing every `engine.send()` caller (GroupSession, GroupRuntime, MarmotGroup) to handle a new variant.

### Q3 — Should the inbound `rejected` result gain a reason discriminator?

| Option               | Description                                                                                                                               | Selected |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Add a reason field   | `reason: 'admin-policy' \| 'component-integrity' \| 'admin-leaf-coupling'` (extensible); disposition mapping stays `authorization_failed` | ✓        |
| Leave rejected as-is | All rejection causes indistinguishable at the API, only separable via `debug` logs                                                        |          |
| You decide           | Claude picks during planning                                                                                                              |          |

**User's choice:** Add a reason field
**Notes:** Spec check performed mid-discussion: `refs/marmot/foundation/errors.md` fixes the category list and confirms `authorization_failed` is correct for a committer not allowed to make the change — so the existing mapping already conforms and only diagnostics were open. Enum-only reason values satisfy the spec's diagnostics-privacy rule.

### Q4 — What about commits already accepted pre-fix in persisted history trees?

| Option                       | Description                                                                                                                                 | Selected |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Validate all edges uniformly | Apply the check to every candidate edge including replayed persisted ones; accept possible unselectable branch / `Unrecoverable` on upgrade | ✓        |
| Grandfather persisted edges  | Only validate newly-ingested commits                                                                                                        |          |
| You decide                   | Claude picks during planning                                                                                                                |          |

**User's choice:** Validate all edges uniformly
**Notes:** Grandfathering would make the three seams disagree, which success criterion 1 explicitly forbids. A group carrying a violating commit is already forked from any conformant peer.

---

## Admin/leaf coupling (CONV-01)

### Q1 — Auto-couple on send, or reject and make the caller couple?

| Option                     | Description                                                                                                                                                          | Selected |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Auto-couple (mirror MDK)   | Derive resulting admin set = current leaves minus removed leaves; splice an admin-policy `AppDataUpdate` dropping de-leafed keys into the same commit, then validate | ✓        |
| Reject, caller must couple | Throw on send; caller passes an explicit admin-policy update alongside the removal                                                                                   |          |
| You decide                 | Claude picks during planning                                                                                                                                         |          |

**User's choice:** Auto-couple (mirror MDK)
**Notes:** Grounded in `refs/mdk/.../message_processor/send.rs` L395-460 read during discussion. Rejecting would produce a different commit shape than MDK for the same app-level intent. Noted during discussion: `proposeRemoveUser` is a `ProposalAction` builder, so coupling must live in the commit-staging path, not the proposal builder.

### Q2 — What if the removal would empty the admin set?

| Option                      | Description                                                                  | Selected |
| --------------------------- | ---------------------------------------------------------------------------- | -------- |
| Guard with a distinct error | Mirror MDK's `AdminDepletion`; refuse before staging with its own error type | ✓        |
| Let the codec throw         | Auto-coupling to an empty list hits `encodeAdminPolicy`'s existing throw     |          |
| You decide                  | Claude picks during planning                                                 |          |

**User's choice:** Guard with a distinct error
**Notes:** The codec throw ("admin-policy must contain at least one admin") surfaces from the wrong layer with no actionable message.

### Q3 — Account-level or leaf-level survival rule?

| Option                     | Description                                                        | Selected |
| -------------------------- | ------------------------------------------------------------------ | -------- |
| Account-level (mirror MDK) | Drop an admin key only when none of that account's leaves survives | ✓        |
| Leaf-level (simpler)       | One leaf = one member, under the single-device assumption          |          |
| You decide                 | Claude picks during planning                                       |          |

**User's choice:** Account-level (mirror MDK)
**Notes:** Costs nothing (`getPubkeyLeafNodeIndexes` already maps pubkey→leaves) and avoids revisiting when MIP-06 lands. Leaf-level diverges the moment any account has two leaves, which the wire format already permits.

### Q4 — Should coupling gate convergence/replay candidate edges too?

| Option                  | Description                                                                                          | Selected |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| Yes — all three seams   | Enforce on send, inbound, and convergence/replay                                                     | ✓        |
| Send + inbound only     | No upgrade breakage for groups already carrying an orphaned admin key                                |          |
| Yes, plus a repair path | Enforce everywhere and surface the orphaned-admin condition so an app can commit a corrective update |          |

**User's choice:** Yes — all three seams
**Notes:** Risk explicitly acknowledged as higher than WIRE-03's, since marmot-ts has never enforced coupling and real groups may already be non-conformant. The repair path was deferred as its own feature.

---

## Removal & withdrawal (CONV-02+03)

### Q1 — What should a "state notification" actually be?

| Option                     | Description                                                                                                                                            | Selected |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Typed notification objects | `StateNotification` variants (epochAdvanced, memberAdded, memberRemoved, componentChanged, selfRemoved, branchRecovered), each carrying `commitDigest` | ✓        |
| Attribute + withdraw only  | No notification objects; attribute `processed` with `commitDigest` and add a withdrawal result                                                         |          |
| Typed, but a minimal set   | Only the variants this phase needs (selfRemoved, memberRemoved, componentChanged)                                                                      |          |

**User's choice:** Typed notification objects
**Notes:** Established during discussion that marmot-ts has no `commit_digest`-attributed notification concept today (only `processed` results plus `stateChanged`/`historyChanged` events), so CONV-03 requires introducing one. The spec makes shape implementation-defined but requires the correct resulting view — the "attribute + withdraw only" option would have pushed the hard half downstream to the app.

### Q2 — How do notifications and withdrawal reach the app?

| Option                  | Description                                                                                                                                               | Selected |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Ingest results + ledger | `notifications: StateNotification[]` on `processed`; a `stateInvalidated` result on rewind; ledger mirrors `DeliveredPayloadLedger.invalidatedByRewind()` | ✓        |
| EventEmitter events     | `stateNotification` / `stateInvalidated` from MarmotGroup's EventEmitter                                                                                  |          |
| Both                    | Results canonical, MarmotGroup re-emits as events for convenience                                                                                         |          |

**User's choice:** Ingest results + ledger
**Notes:** `convergence.md` explicitly calls state-notification withdrawal the counterpart of app-payload invalidation, so mirroring the existing ledger is the spec-aligned shape. Keeps ordering vs `invalidated` retractions deterministic in the generator.

### Q3 — How is the removed-inactive mark tracked and cleared?

| Option                     | Description                                                                                                 | Selected |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| Explicit persisted marker  | Separate from the MLS `removedFromGroup` tombstone; realize on load when unset; CONV-03 clears it on rewind | ✓        |
| Derive from MLS state only | Emit selfRemoved whenever state is a tombstone; rewind clears it for free                                   |          |
| You decide                 | Claude picks during planning                                                                                |          |

**User's choice:** Explicit persisted marker
**Notes:** The roadmap requires clearing removal markers on rewind, which is only expressible with a marker distinct from MLS state. "Derive only" also loses the emit-exactly-once property the spec's marker language implies.

### Q4 — What shape for SelfEvicted classification?

| Option                | Description                                                                                                                                                           | Selected |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| New skipped reason    | `'self-evicted'` on `SkippedIngestResult.reason`; short-circuit the batch before peel/decrypt; add `SelfEvicted: inputCategories.staleEpoch` to the named-outcome map | ✓        |
| New IngestResult kind | Top-level `{ kind: 'selfEvicted' }` variant                                                                                                                           |          |
| You decide            | Claude picks during planning                                                                                                                                          |          |

**User's choice:** New skipped reason
**Notes:** Reuses the existing pattern (`BeyondAnchor`, `MissingRetainedAnchor` already map that way). A new top-level kind would break the kind↔disposition correspondence, since this is a `stale` disposition like every other skip reason.

### Q5 — Where does the outbound block for a removed member go?

| Option             | Description                                                          | Selected |
| ------------------ | -------------------------------------------------------------------- | -------- |
| Engine-level throw | Guard in `MarmotGroupEngine.send()` before any staging               | ✓        |
| Client-level guard | Guard in `MarmotGroup`/`GroupRuntime` beside `#rejectQueuedOutbound` |          |
| Both               | Engine throws as hard invariant; client gives a good error           |          |

**User's choice:** Engine-level throw
**Notes:** Catches a fresh `send()` after restart, which the existing queued-outbound rejection does not. Consistent with the WIRE-03 send-path decision.

---

## CONV-04 verify-first scope

### Q1 — How much of the vector driver should Phase 3 build?

| Option                        | Description                                                                             | Selected           |
| ----------------------------- | --------------------------------------------------------------------------------------- | ------------------ |
| Minimal reusable driver       | Step interpreter for the needed step types + three assertion types, extended by Phase 4 | ✓ (later reversed) |
| Hand-derived Vitest tests     | Transcribe scenarios into idiomatic marmot-ts test code by hand                         |                    |
| Throwaway verification script | One-off, record the verdict, delete                                                     |                    |

**User's choice:** Minimal reusable driver — **subsequently reversed, see Q2**

### Q2 — How to establish the own-confirmed-commit verdict, given no shipped vector covers it?

| Option                     | Description                                                                                  | Selected |
| -------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| Run available + derive one | Run existing fork-recovery/convergence vectors and author one new fixture from MDK #706/#723 |          |
| Run available vectors only | Treat existing fork-recovery outcomes as sufficient evidence                                 |          |
| You decide                 | Claude picks during planning                                                                 |          |
| **Other (free text)**      | **"we dont need vector tests"**                                                              | ✓        |

**User's choice:** Free text — "we dont need vector tests"
**Notes:** Clarified in plain text with two candidate scopes; the user selected **scope 1**: no vector-driven testing in Phase 3 at all, including dropping the minimal driver. CONV-04 is verified by reading the MDK Rust (#706/#723 `1551a7a`, #363/#702 `ddf2602`, #724 `b255836`) against `fork-recovery.ts`/`tree-convergence.ts` plus native Vitest tests. The entire vector/parity harness stays in Phase 4 (CONF-01). This supersedes the Q1 answer.

**Finding surfaced during this area:** the shipped MDK vector set contains no fixture named for own-confirmed-commit protection; nearest coverage is `group-data-fork-recovery`, `concurrent-invite-fork-recovery`, `partition-clear-leave`, `convergence-committer-selected`/`-witness-selected`, and `vectors/incidents/*`. Recorded for Phase 4.

### Q3 — What should the native CONV-04 tests assert?

| Option                     | Description                                                                                                                                       | Selected |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Own-commit + dual-ordering | (a) own published+confirmed commit not rolled back for a same-epoch sibling; (b) two instances fed opposite delivery order select the same branch | ✓        |
| Own-commit protection only | Criterion 5's literal wording alone                                                                                                               |          |
| You decide                 | Claude picks during planning                                                                                                                      |          |

**User's choice:** Own-commit + dual-ordering
**Notes:** `.planning/codebase/CONCERNS.md` already flags dual-ordering as the safety net for `fork-recovery.ts` — arrival order leaking into the comparator is how two impls silently diverge.

---

## Claude's Discretion

- Exact module layout and export names for the integrity validator and its per-seam adapters.
- How the staged commit's own `AppDataUpdate` ops are obtained at each seam (ts-mls's `IncomingMessageCallback` exposes proposals pre-apply; the resulting `GroupContext` is post-apply).
- Whether the admin/leaf coupling validator shares `integrity.ts` or sits beside the codec in `admin-policy.ts`.
- `StateNotification` variant names, field shapes, and the ledger's pruning horizon.
- Where the persisted removed-inactive marker is stored.
- Whether `MarmotGroup` re-emits state notifications as convenience events.
- Plan decomposition and wave structure across the five requirements.

## Deferred Ideas

- **Scenario-vector parity harness** — Phase 4 / CONF-01, explicitly not Phase 3.
- **Orphaned-admin repair flow** — detect the condition on load and let an app commit a corrective admin-policy update; its own feature.
- **`MarmotGroup` event re-emission of state notifications** — left open as a later ergonomic addition.
- **SafeAAD advertisement (WIRE-04)** and **byte-exact MDK cross-check recording (QA-02)** — Phase 4 and Phase 5.
