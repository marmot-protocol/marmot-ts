# Phase 3: Commit Integrity & Convergence Parity - Context

**Gathered:** 2026-07-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Make staged commits and membership/convergence handling match MDK's legality and
rewind semantics, so marmot-ts and the Rust reference never silently fork on a
component-mutating or membership-changing commit. Closes five requirements:

- **WIRE-03** — app-component integrity on staged commits: reject pre-merge any commit
  whose resulting `GroupContext` drops the `app_data_dictionary`, drops a required
  component, or rewrites a required component's bytes outside a validated
  `AppDataUpdate` — identically on send, inbound, and convergence/replay.
- **CONV-01** — admin/leaf coupling as a resulting-epoch invariant: every
  membership-changing commit must leave admins ⊆ member-leaf accounts; a
  removal-without-policy-update commit MDK deems illegal is rejected identically here.
- **CONV-02** — SelfEvicted / "Realizing removal": emit a self-removed notification,
  mark the group removed-inactive with no further outbound, and classify later input
  for that group as SelfEvicted/stale.
- **CONV-03** — state notifications attributed to their originating `commit_digest`
  and withdrawn (including clearing removal markers) when that commit is superseded
  on rewind.
- **CONV-04** — **verify-first**: confirm a device's own published+confirmed commit is
  never rolled back for a same-epoch sibling. A clean pass requires no code change;
  any divergence found is fixed before this phase closes.

**In scope:** the three commit seams (send staging, inbound commit branch,
convergence/replay candidate-edge construction); a new component-integrity validator;
admin/leaf coupling on send + validate; the removed-inactive marker and realization
flow; a `commit_digest`-attributed state-notification model with rewind withdrawal;
native tests for own-confirmed-commit protection.

**Out of scope (own phases):** SafeAAD advertisement (WIRE-04) and wiring MDK's
conformance/scenario vectors as an automated parity harness (CONF-01) — **Phase 4**.
Cross-runtime green suite and byte-exact MDK cross-check recording (QA-01/02) —
**Phase 5**. No multi-device (MIP-06) or push (MIP-05) work.

**Wire format is authoritative from the MDK Rust reference, not the lagging spec
prose** (carried forward from Phases 1 and 2).

</domain>

<decisions>
## Implementation Decisions

### App-component integrity (WIRE-03)

- **D-01 (LOCKED):** The validator is a **pure function in `src/core/components/`**
  (new `integrity.ts`), e.g. `validateAppComponentIntegrity({ currentExtensions,
resultingExtensions, appDataUpdateOps, requiredIds })` returning a typed result.
  Matches the "core = protocol logic, zero I/O" rule, is unit-testable without real
  MLS state, and Phase 4's vector harness can call it directly. The engine wires it at
  each seam. (MDK keeps this inside `cgka-engine`, but MDK has no core/engine split.)
- **D-02 (LOCKED):** On the **send path a violation throws** (e.g. `UsageError`, already
  used by `buildAppDataDictionary`) from the staging step, before the commit is wrapped
  or published. `SendResult<TEnvelope>` is **unchanged** — no new failure variant, no
  downstream API churn. A locally-built violating commit is a programming error, not an
  expected outcome; this matches the codebase rule "throw for domain/validation
  failures, typed results for expected multi-outcome inbound flows."
- **D-03 (LOCKED):** On the **inbound path**, reuse the existing `rejected`
  `IngestResult` (→ `authorization_failed`, which `foundation/errors.md` confirms is the
  correct category — the committer is not allowed to make the change). **Widen
  `RejectedIngestResult` with a `reason` discriminator**: `'admin-policy' |
'component-integrity' | 'admin-leaf-coupling'` (extensible). Additive field, no
  disposition-mapping change, no spec divergence. Reason values are enum-only, so the
  spec's diagnostics-privacy rule is satisfied.
- **D-04 (LOCKED):** **Validate all candidate edges uniformly**, including edges
  replayed from persisted history trees. Accepted consequence: a downstream app whose
  stored tree contains a previously-accepted violating commit may find that branch
  unselectable after upgrade (worst case the group goes `Unrecoverable`). Such a group
  is already forked from any conformant peer. Grandfathering was explicitly rejected —
  success criterion 1 requires the three seams to agree.

### Admin/leaf coupling (CONV-01)

- **D-05 (LOCKED):** On **send, auto-couple** (mirror `refs/mdk/.../send.rs`): derive the
  resulting admin set as _current leaves minus removed leaves_; if any admin loses their
  last leaf, splice an admin-policy `AppDataUpdate` dropping those keys into the **same
  commit**, then validate. This gives byte-for-byte parity — the same removal intent
  produces the same commit shape in both impls. Rejected alternative: throwing and making
  the caller supply the policy update (diverges from MDK for the same app-level intent).
- **D-06 (LOCKED):** Auto-coupling **cannot live in `proposeRemoveUser`** — marmot-ts
  models removal as a `ProposalAction` builder composed into a commit via
  `submitIntent`/`propose`, and a commit may carry arbitrary extra proposals. The coupling
  logic belongs in the **commit-staging path**, which is where MDK does it too.
- **D-07 (LOCKED):** **Explicit admin-depletion guard** when the removal would empty the
  admin set (mirror MDK's `AdminDepletion`), with its own error type/message, refusing the
  removal before staging. Today this would surface as `encodeAdminPolicy`'s
  "admin-policy must contain at least one admin" throw from deep inside the codec — wrong
  layer, no actionable message.
- **D-08 (LOCKED):** **Account-level survival rule** (mirror MDK): map surviving leaves to
  account pubkeys via the credential; drop an admin key only when **none** of that
  account's leaves survives. Costs nothing (`getPubkeyLeafNodeIndexes` already does the
  pubkey→leaves mapping) and does not need revisiting when MIP-06 lands. Leaf-level was
  rejected — it diverges the moment any account has two leaves, which the wire format
  already permits.
- **D-09 (LOCKED):** Coupling is enforced at **all three seams** (send, inbound,
  convergence/replay), same uniform treatment as D-04. Accepted risk is higher here than
  for WIRE-03: marmot-ts has never enforced coupling, so real groups may already carry an
  orphaned admin key and could find branches unselectable on upgrade. A corrective/repair
  flow was considered and deferred as its own feature.

### Removal, notifications, and withdrawal (CONV-02 + CONV-03)

- **D-10 (LOCKED):** Introduce **typed `StateNotification` objects** — variants covering
  `epochAdvanced`, `memberAdded`, `memberRemoved`, `componentChanged`, `selfRemoved`,
  `branchRecovered` — each carrying the **`commitDigest`** of the commit it derives from,
  emitted per accepted commit. The spec makes notification shape implementation-defined
  and requires only the correct _resulting view_; typed objects are what let an app undo
  exactly the announced changes on withdrawal.
- **D-11 (LOCKED):** **Delivery is via ingest results plus a ledger**, not the
  EventEmitter. Notifications ride on the `processed` `IngestResult` (a
  `notifications: StateNotification[]` field); a `stateInvalidated` result on rewind names
  the superseded `commitDigest` and the withdrawn notifications. This mirrors
  `DeliveredPayloadLedger.invalidatedByRewind()` — which `convergence.md` explicitly calls
  this rule's counterpart — and keeps ordering relative to app-payload `invalidated`
  retractions deterministic inside the drainable generator.
- **D-12 (LOCKED):** **Explicit persisted removed-inactive marker**, separate from the MLS
  `removedFromGroup` tombstone. On load, if canonical state records our removal and the
  marker is unset, realize (emit `selfRemoved`, set marker) — realization is a
  state-derived obligation, not a one-shot at commit-apply. CONV-03 **clears the marker**
  when a rewind supersedes the removing commit, which the roadmap explicitly requires and
  which is only expressible with a marker distinct from MLS state.
- **D-13 (LOCKED):** Later input for a removed group becomes a **new `'self-evicted'`
  `SkippedIngestResult.reason`**, short-circuiting the whole batch **before any
  peel/decrypt** (the spec says such input "need not be decrypted or authenticated" — it
  is classified by its group). Add `SelfEvicted: inputCategories.staleEpoch` to the
  named-outcome map in `src/core/inbound.ts`, alongside the existing `BeyondAnchor` and
  `MissingRetainedAnchor` entries. A new top-level `IngestResult` kind was rejected: this
  is a `stale` disposition like every other skip reason, and promoting it would break the
  kind↔disposition correspondence and every exhaustive switch.
- **D-14 (LOCKED):** The outbound block is an **engine-level throw** in
  `MarmotGroupEngine.send()`, before any staging — one chokepoint that also covers a fresh
  `send()` after restart, consistent with D-02. `MarmotGroup`'s existing
  `#rejectQueuedOutbound` on the `removed` event stays as-is.

### Own-confirmed-commit protection (CONV-04, verify-first)

- **D-15 (LOCKED):** **No vector-driven testing in Phase 3.** Do not build a scenario-vector
  driver, and do not author new vector fixtures. CONV-04 is verified by **reading the MDK
  Rust** (#706/#723 `1551a7a`, #363/#702 `ddf2602`, #724 `b255836`) against
  `src/engine/fork-recovery.ts` and `src/engine/tree-convergence.ts`, and writing **native
  Vitest tests** for the properties that reading establishes. The entire vector/parity
  harness stays in **Phase 4 (CONF-01)** where it is already scoped.
  _(This supersedes an earlier in-discussion answer that favored building a minimal
  reusable driver — the user reversed it explicitly.)_
- **D-16 (LOCKED):** The native tests assert **two** properties:
  1. A device's own published+confirmed commit is **not rolled back** in favor of a
     same-epoch sibling (criterion 5's literal claim).
  2. **Dual-ordering**: two in-memory instances fed the same commits in **opposite
     delivery order** select the **same branch**. `.planning/codebase/CONCERNS.md` flags
     this as the safety net for `fork-recovery.ts` — arrival order leaking into the
     comparator is exactly how two impls silently diverge — and it is what makes the
     own-commit rule meaningful rather than accidental.
- **Note for the researcher:** the shipped MDK vector set contains **no fixture named for
  own-confirmed-commit protection**. The nearest coverage is `group-data-fork-recovery`,
  `concurrent-invite-fork-recovery`, `partition-clear-leave`,
  `convergence-committer-selected`/`-witness-selected`, and `vectors/incidents/*`. This is
  informational for Phase 4 planning; Phase 3 does not consume them.

### Claude's Discretion

- Exact module layout and export names for the integrity validator and its adapters at
  each of the three seams.
- How the staged commit's own `AppDataUpdate` operations are obtained at each seam
  (ts-mls's `IncomingMessageCallback` exposes `incoming.proposals` pre-apply, but the
  resulting `GroupContext` is only available post-apply — reconciling these is a planning
  concern).
- Whether the admin/leaf coupling validator lives in the same new
  `src/core/components/integrity.ts` or beside the codec in
  `src/core/components/admin-policy.ts`.
- Exact `StateNotification` variant names, field shapes, and the ledger's pruning
  horizon (mirror `DeliveredPayloadLedger.pruneBelow` semantics unless research says
  otherwise).
- Where the persisted removed-inactive marker is stored (group metadata vs. a sibling
  key in the existing `GenericKeyValueStore`).
- Whether `MarmotGroup` additionally re-emits state notifications as events for app
  convenience (results are canonical either way).
- Plan decomposition and wave structure across the five requirements.

### Folded Todos

- **`groupsmanager-rejectedevents-dos`** (from `02-REVIEW.md`, front-matter
  `resolves_phase: 3`) — **folded into this phase.** `#connectGroup`'s drain
  (`src/client/groups-manager.ts` ~L495) keeps an unbounded `Set<NostrEvent>` of
  already-rejected event _objects_ for the connection lifetime; a hostile relay can pin
  memory indefinitely (DoS-adjacent), and its object-identity dedup does not work in
  production (fresh deserialized objects per relay message) so it only ever suppresses a
  duplicate under `MockNetwork`'s shared-array replay. **Recommended fix (from the todo):**
  drop `rejectedEvents` entirely and filter only on `!seen.has(event.id)`; accept that a
  backfill+subscription redelivery of the same malformed event emits `rejected` twice
  (informational, not a protocol-safety concern, and matches the `InviteManager` sibling
  boundary). Loosen the two exact-count tests in `src/__tests__/groups-manager.test.ts`
  ("rejects an inbound 445 event with an invalid signature", "rejects a properly-signed
  445 event carrying a duplicate h tag") from `toHaveLength(1)` to `>= 1` with all reasons
  asserted. **Do NOT dedup rejections by `event.id`** — that re-opens the WR-01 censorship
  bug (a same-id genuine event must still be processed).

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### MDK Rust reference (authoritative for wire format and legality decisions)

- `refs/mdk/crates/cgka-engine/src/app_components.rs` — the two validators to port:
  `validate_app_component_integrity_for_staged_commit` (~L345) and
  `validate_admin_leaf_coupling_for_staged_commit` (~L240), plus
  `reject_admins_without_member_leaf` (~L416) and `reject_admin_self_remove_proposals`
  (~L473). **Read the integrity fn's attribution rule carefully**: every dictionary entry
  that changes vs the current epoch must match one of the commit's own `AppDataUpdate`
  ops (`None` = Remove); the protected set is
  `required_app_components_of_group().ids` **plus** `APP_COMPONENTS_COMPONENT_ID`.
- `refs/mdk/crates/cgka-engine/src/message_processor/send.rs` (~L395-460) — the
  auto-coupling algorithm and `AdminDepletion` guard (~L380), then both validators called
  on the staged commit.
- `refs/mdk/crates/cgka-engine/src/message_processor/ingest.rs` (~L858) — inbound seam.
- `refs/mdk/crates/cgka-engine/src/openmls_projection.rs` (~L1943) — convergence/replay seam.
- `refs/mdk/crates/cgka-engine/src/upgrade.rs` (~L217) — the fourth MDK seam
  (GCE-authoring upgrade path); check whether marmot-ts has an equivalent.
- MDK commits/PRs for CONV-04: #706/#723 (`1551a7a`, own confirmed commits as
  pre-validated convergence candidates), #363/#702 (`ddf2602`), #724 (`b255836`, clear
  removed-marker on branch supersession), #701 (`5f0d60b`, admin-policy coupled to
  member-removal on send + validate).

### Spec (post-split, `#171` / `#704`)

- `refs/marmot/app-components/admin-policy-v1.md` §"Validation" — the resulting-epoch
  cross-component check (~L32-73): an account is an active admin only with ≥1 current
  member leaf; a commit removing a listed account's last leaf MUST also drop its key in
  the same commit; the check runs on every commit that changes the member leaf set **or**
  this component's state, evaluated against the carried-forward admin set when the commit
  carries no admin-policy bytes. **SelfRemove never triggers the coupling rule.**
- `refs/marmot/protocol-core/member-departure.md` §"Realizing removal" — realization is a
  state-derived obligation; self-removed notification + mark removed; later input gets
  `SelfEvicted`; a removed copy is retained inactive (no outbound, not presented as
  active); failure to decrypt is **not** evidence of removal.
- `refs/marmot/protocol-core/convergence.md` (~L205-232) — state notifications derived
  only from accepted commits on the selected branch, attributed to `commit_digest`;
  group-state-change invalidation + withdrawal on supersession; notification shape is
  implementation-defined, the _resulting view_ is the conformance requirement.
- `refs/marmot/foundation/errors.md` — the fixed input-category list (do not invent new
  categories); pre-convergence rejections are described "by category alone"; the named
  outcome table maps `SelfEvicted` → `stale` / `stale_epoch`.
- `refs/marmot/protocol-core/inbound-processing.md` — application-visible output and the
  fail-closed path.

### Phase research (authoritative for this milestone)

- `.planning/research/MDK-INTEROP.md` findings **1** (app-component integrity), **5**
  (own confirmed commit protected / `GroupStateInvalidated`), **6** (removed-marker clear
  on supersession + admin-policy coupling).
- `.planning/research/SPEC-DELTAS.md` findings **4** (admin/leaf coupling), **5**
  (`SelfEvicted` / Realizing removal), **6** (state-notification withdrawal).
- `.planning/research/SUMMARY.md` — catchup review overview and severity ordering.

### marmot-ts source to change

- `src/core/components/integrity.ts` — **new**, the pure validator (D-01).
- `src/core/components/dictionary.ts` — `getComponentData`, `buildAppDataDictionary`,
  `makeAppComponentsExtension`; the dictionary read helpers the validator sits on.
- `src/core/components/admin-policy.ts` — codec only today; already throws
  "admin-policy must contain at least one admin" on encode and decode.
- `src/core/client-state.ts` (~L302) — `requiredComponentIds` derivation from the
  `app_components` (0x0001) entry; the source of the protected-id set.
- `src/core/inbound.ts` — `inputCategories`, `Disposition`, and the named-outcome map
  (`BeyondAnchor` / `MissingRetainedAnchor`) that `SelfEvicted` joins.
- `src/engine/types.ts` — `RejectedIngestResult` (add `reason`), `SkippedIngestResult`
  (add `'self-evicted'`), `ProcessedIngestResult` (add `notifications`), plus a new
  `stateInvalidated` variant; `RemovedIngestResult` already exists.
- `src/engine/ingest-disposition.ts` — one new case per added reason/kind.
- `src/engine/ingest.ts` (~L610-700) — the inbound commit branch, the existing
  `removedFromGroup` handling, and the rewind path that already re-reports `removed`.
- `src/engine/admin-policy.ts` — `createAdminCommitPolicyCallback`; note it is a **ts-mls
  `IncomingMessageCallback` running pre-apply**, so the resulting-epoch invariant cannot
  live there unmodified.
- `src/engine/group-engine.ts` — `send()` (D-14 throw, D-02 throw, D-05 auto-couple in
  the staging path).
- `src/engine/fork-recovery.ts`, `src/engine/tree-convergence.ts` — candidate-edge
  construction (D-04/D-09 seam) and the CONV-04 subject under test.
- `src/engine/delivered-payloads.ts` — `DeliveredPayloadLedger.invalidatedByRewind()` /
  `pruneBelow()`, the template for the state-notification ledger (D-11).
- `src/client/group/proposals/remove-member.ts` — `proposeRemoveUser`; a `ProposalAction`
  builder, **not** the place for auto-coupling (D-06).
- `src/client/group/marmot-group.ts` (~L660-700, event map ~L195-227) — the existing
  `removed` event and `#rejectQueuedOutbound`.
- `src/client/groups-manager.ts` (~L495-540) — the folded todo's `rejectedEvents` drain.
- `src/core/group-members.ts` — `getPubkeyLeafNodeIndexes` (account→leaves mapping for D-08).

### Prior phase context (decisions carried forward)

- `.planning/phases/02-inbound-trust-wire-boundary/02-CONTEXT.md` — MDK-authoritative wire
  format; reject-via-typed-result for inbound; engine stays transport-agnostic.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- **`DeliveredPayloadLedger`** (`src/engine/delivered-payloads.ts`) — bounded ledger with
  `record()` / `invalidatedByRewind(forkEpoch, canonicalTags)` / `pruneBelow(epoch)`. The
  spec calls state-notification withdrawal "the counterpart of app-payload invalidation",
  so this is the shape to mirror for CONV-03, not a new invention.
- **`removedFromGroup` tombstone + `RemovedIngestResult` + `removed` event** — CONV-02 is a
  **partial** gap, not greenfield. `ingest.ts` already detects the tombstone on the commit
  branch (~L626) and on the rewind path (~L687), `MarmotGroup` already fails queued
  outbound and emits `removed`. What's missing: state-derived realization on load, the
  persisted marker, the outbound block for fresh sends, and `SelfEvicted` classification.
- **Named-outcome map in `src/core/inbound.ts`** (~L89-92) — `BeyondAnchor` and
  `MissingRetainedAnchor` already map spec-named outcomes to `InputCategory`; `SelfEvicted`
  slots in with one line.
- **`commitDigest()`** (`src/core/convergence.ts` ~L298) — SHA-256 over commit MLS bytes,
  already used by `history-tree.ts`, `fork-recovery.ts`, and `ingest.ts` (~L247). CONV-03's
  attribution key already exists.
- **`getPubkeyLeafNodeIndexes`** (`src/core/group-members.ts`) — the account→leaves mapping
  D-08 needs.
- **`UsageError`** — already thrown by `buildAppDataDictionary` for duplicate component ids;
  the precedent for D-02/D-07.

### Established Patterns

- **`src/core` has zero I/O** and holds pure protocol/crypto/state logic; the engine is the
  state machine; the client owns Nostr. D-01 follows this even though MDK does not split.
- **Discriminated unions with a `kind` discriminant** for multi-outcome results; each
  `IngestResult` kind maps to exactly one `Disposition` via `ingestResultDisposition`.
  D-13 preserves that correspondence deliberately.
- **Throw for domain/validation failures, typed results for expected inbound multi-outcome
  flows** — the split D-02/D-14 (throw) vs D-03/D-13 (typed) follows.
- Named exports, `.js` import extensions on all relative imports, `Uint8Array` for binary,
  SCREAMING_SNAKE_CASE protocol constants, native `#` private fields.
- Colocated tests under `src/**/__tests__`; shared doubles in `src/__tests__/helpers`
  (in-memory stores + `MockNetwork`).

### Integration Points

- **Send seam:** `MarmotGroupEngine.send()` commit-staging path — D-02 integrity throw,
  D-05 auto-couple, D-07 depletion guard, D-14 removed-group block all land here.
- **Inbound seam:** `ingest.ts` commit branch, after `processMessage` produces
  `result.newState` but before `ctx.setState` / `ctx.recordCommit`.
- **Convergence/replay seam:** candidate-edge construction in `fork-recovery.ts` /
  `tree-convergence.ts`, feeding `ctx.resolveFork` (`ingest.ts` ~L668).
- **Realization on load:** wherever `MarmotGroup` restores from its
  `GenericKeyValueStore<SerializedClientState>` (`fromClientState` / load path) — the
  marker check runs there, not only on inbound.

</code_context>

<specifics>
## Specific Ideas

- The five ROADMAP success criteria are the acceptance bar; criterion 1 explicitly demands
  the integrity check behave **identically** on send, inbound, and convergence/replay —
  that is why D-04/D-09 chose uniform enforcement over grandfathering.
- The user's guiding preference throughout: **mirror MDK exactly where a behavioral choice
  exists** (auto-coupling, account-level survival, uniform seam enforcement), because a
  different commit shape for the same intent is a silent fork.
- The user explicitly rejected building any scenario-vector driver in this phase — Phase 3
  stays focused on the five requirements, and vector infrastructure is Phase 4's job (D-15).
- Accepted upgrade risk, stated plainly: enforcing at the replay seam can render an
  existing group's branch unselectable. The user accepted this for both WIRE-03 and
  CONV-01 rather than let the seams disagree.

</specifics>

<deferred>
## Deferred Ideas

- **Scenario-vector parity harness** — a step interpreter for MDK's
  `cgka-conformance-simulator` vectors (`create_group`, `invite_members`, `pending` /
  `confirm_pending`, `deliver_all`, `tick`, `observe`, `clear_events`) with
  `expected_outcomes` assertions (`convergence_decision` incl. `decisive_rule`,
  `pending_resolution`, `client_state`). Explicitly **Phase 4 / CONF-01**, not Phase 3.
  Noted for that phase: no shipped fixture is named for own-confirmed-commit protection;
  nearest coverage is `group-data-fork-recovery`, `concurrent-invite-fork-recovery`,
  `partition-clear-leave`, `convergence-committer-selected`/`-witness-selected`, and
  `vectors/incidents/*`.
- **Orphaned-admin repair flow** — detecting the orphaned-admin condition on load and
  surfacing it so an app can commit a corrective admin-policy update, instead of just
  hitting an unselectable branch. Considered during CONV-01 and deferred as its own
  feature; not required by any Phase 3 criterion.
- **`MarmotGroup` event re-emission of state notifications** — results are canonical
  (D-11); adding convenience events is left open as Claude's discretion / a later
  ergonomic addition.
- **SafeAAD advertisement (WIRE-04)** and **byte-exact MDK cross-check recording
  (QA-02)** — Phase 4 and Phase 5 respectively, untouched here.

</deferred>

---

_Phase: 03-commit-integrity-convergence-parity_
_Context gathered: 2026-07-29_
