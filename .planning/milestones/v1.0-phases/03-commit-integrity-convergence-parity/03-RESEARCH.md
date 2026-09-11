# Phase 3: Commit Integrity & Convergence Parity - Research

**Researched:** 2026-08-04
**Domain:** MLS commit validation (app-component integrity + admin/leaf coupling), member-departure realization, commit-digest-attributed state notifications, convergence/fork-recovery parity — ported from the MDK Rust reference into a ts-mls-backed engine
**Confidence:** HIGH — every algorithm below was read directly from `refs/mdk` Rust source and cross-checked against the current marmot-ts engine/core source and the post-split spec text in `refs/marmot`. No web search was needed; this phase is entirely internal porting work with no new external dependencies.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** The validator is a **pure function in `src/core/components/`** (new `integrity.ts`), e.g.
  `validateAppComponentIntegrity({ currentExtensions, resultingExtensions, appDataUpdateOps, requiredIds })` returning
  a typed result. Matches "core = protocol logic, zero I/O", is unit-testable without real MLS state, and Phase 4's
  vector harness can call it directly. The engine wires it at each seam.
- **D-02:** On the **send path a violation throws** (e.g. `UsageError`, already used by `buildAppDataDictionary`) from
  the staging step, before the commit is wrapped or published. `SendResult<TEnvelope>` is **unchanged**.
- **D-03:** On the **inbound path**, reuse the existing `rejected` `IngestResult` (→ `authorization_failed`). **Widen
  `RejectedIngestResult` with a `reason` discriminator**: `'admin-policy' | 'component-integrity' |
'admin-leaf-coupling'` (extensible). Additive field, no disposition-mapping change.
- **D-04:** **Validate all candidate edges uniformly**, including edges replayed from persisted history trees.
  Accepted consequence: a downstream app whose stored tree contains a previously-accepted violating commit may find
  that branch unselectable after upgrade (worst case `Unrecoverable`). Grandfathering was explicitly rejected —
  criterion 1 requires the three seams to agree.
- **D-05:** On **send, auto-couple** (mirror `refs/mdk/.../send.rs`): derive the resulting admin set as _current
  leaves minus removed leaves_; if any admin loses their last leaf, splice an admin-policy `AppDataUpdate` dropping
  those keys into the **same commit**, then validate. Rejected alternative: throwing and making the caller supply the
  policy update (diverges from MDK for the same app-level intent).
- **D-06:** Auto-coupling **cannot live in `proposeRemoveUser`** — marmot-ts models removal as a `ProposalAction`
  builder composed into a commit via `submitIntent`/`propose`, and a commit may carry arbitrary extra proposals. The
  coupling logic belongs in the **commit-staging path** (`MarmotGroupEngine.send()`'s `"commit"` case), which is
  where MDK does it too.
- **D-07:** **Explicit admin-depletion guard** when the removal would empty the admin set (mirror MDK's
  `AdminDepletion`), with its own error type/message, refusing the removal before staging.
- **D-08:** **Account-level survival rule** (mirror MDK): map surviving leaves to account pubkeys via the credential;
  drop an admin key only when **none** of that account's leaves survives. `getPubkeyLeafNodeIndexes` already does the
  pubkey→leaves mapping. Leaf-level was rejected — it diverges once any account has two leaves.
- **D-09:** Coupling is enforced at **all three seams** (send, inbound, convergence/replay), same uniform treatment as
  D-04. Accepted risk: marmot-ts has never enforced coupling, so real groups may already carry an orphaned admin key
  and could find branches unselectable on upgrade. A repair flow is deferred as its own feature.
- **D-10:** Introduce **typed `StateNotification` objects** — variants covering `epochAdvanced`, `memberAdded`,
  `memberRemoved`, `componentChanged`, `selfRemoved`, `branchRecovered` — each carrying the **`commitDigest`** of the
  commit it derives from, emitted per accepted commit.
- **D-11:** **Delivery is via ingest results plus a ledger**, not the EventEmitter. Notifications ride on the
  `processed` `IngestResult` (a `notifications: StateNotification[]` field); a `stateInvalidated` result on rewind
  names the superseded `commitDigest` and the withdrawn notifications. Mirrors
  `DeliveredPayloadLedger.invalidatedByRewind()`.
- **D-12:** **Explicit persisted removed-inactive marker**, separate from the MLS `removedFromGroup` tombstone. On
  load, if canonical state records our removal and the marker is unset, realize (emit `selfRemoved`, set marker) —
  realization is a state-derived obligation, not a one-shot at commit-apply. CONV-03 **clears the marker** when a
  rewind supersedes the removing commit.
- **D-13:** Later input for a removed group becomes a **new `'self-evicted'` `SkippedIngestResult.reason`**,
  short-circuiting the whole batch **before any peel/decrypt**. Add `SelfEvicted: inputCategories.staleEpoch` to the
  named-outcome map in `src/core/inbound.ts`, alongside `BeyondAnchor` and `MissingRetainedAnchor`. A new top-level
  `IngestResult` kind was rejected — this is a `stale` disposition like every other skip reason.
- **D-14:** The outbound block is an **engine-level throw** in `MarmotGroupEngine.send()`, before any staging — one
  chokepoint that also covers a fresh `send()` after restart, consistent with D-02. `MarmotGroup`'s existing
  `#rejectQueuedOutbound` on the `removed` event stays as-is.
- **D-15:** **No vector-driven testing in Phase 3.** Do not build a scenario-vector driver, and do not author new
  vector fixtures. CONV-04 is verified by **reading the MDK Rust** against `src/engine/fork-recovery.ts` and
  `src/engine/tree-convergence.ts`, and writing **native Vitest tests** for the properties reading establishes. The
  entire vector/parity harness stays in **Phase 4 (CONF-01)**.
- **D-16:** The native tests assert **two** properties: (1) a device's own published+confirmed commit is **not
  rolled back** in favor of a same-epoch sibling; (2) **dual-ordering**: two in-memory instances fed the same
  commits in **opposite delivery order** select the **same branch**.

### Claude's Discretion

- Exact module layout and export names for the integrity validator and its adapters at each of the three seams.
- How the staged commit's own `AppDataUpdate` operations are obtained at each seam (ts-mls's
  `IncomingMessageCallback` exposes `incoming.proposals` pre-apply, but the resulting `GroupContext` is only
  available post-apply — reconciling these is a planning concern; **see "Reconciling pre/post-apply data" below —
  this research resolves the mechanism**).
- Whether the admin/leaf coupling validator lives in the same new `src/core/components/integrity.ts` or beside the
  codec in `src/core/components/admin-policy.ts`.
- Exact `StateNotification` variant names, field shapes, and the ledger's pruning horizon (mirror
  `DeliveredPayloadLedger.pruneBelow` semantics unless research says otherwise).
- Where the persisted removed-inactive marker is stored (group metadata vs. a sibling key in the existing
  `GenericKeyValueStore`).
- Whether `MarmotGroup` additionally re-emits state notifications as events for app convenience (results are
  canonical either way).
- Plan decomposition and wave structure across the five requirements.

### Deferred Ideas (OUT OF SCOPE)

- **Scenario-vector parity harness** — a step interpreter for MDK's `cgka-conformance-simulator` vectors. Explicitly
  **Phase 4 / CONF-01**, not Phase 3. No shipped fixture is named for own-confirmed-commit protection; nearest
  coverage is `group-data-fork-recovery`, `concurrent-invite-fork-recovery`, `partition-clear-leave`,
  `convergence-committer-selected`/`-witness-selected`, and `vectors/incidents/*`.
- **Orphaned-admin repair flow** — detecting the orphaned-admin condition on load and surfacing it for a corrective
  commit, instead of just hitting an unselectable branch. Deferred as its own feature.
- **`MarmotGroup` event re-emission of state notifications** — left open as Claude's discretion / a later ergonomic
  addition.
- **SafeAAD advertisement (WIRE-04)** and **byte-exact MDK cross-check recording (QA-02)** — Phase 4 and Phase 5
  respectively.
  </user_constraints>

<phase_requirements>

## Phase Requirements

| ID                    | Description                                                                                                       | Research Support                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WIRE-03               | App-component integrity validated on staged commits, identically on send/inbound/convergence-replay               | Ported MDK attribution rule (§"Standard Stack"/"Pattern 1"), exact protected-set derivation, and the ts-mls pre/post-apply reconciliation mechanism that lets a pure validator run at all three seams                                                                                                                                                                                                                         |
| CONV-01               | Admin/leaf coupling as a resulting-epoch invariant; MDK-identical legality for removal-without-policy-update      | Ported MDK auto-coupling algorithm (send.rs `do_send_remove_members`) and the account-level survival + `AdminDepletion` guard, mapped onto marmot-ts's `send()` commit-staging path                                                                                                                                                                                                                                           |
| CONV-02               | SelfEvicted / Realizing removal: self-removed notification, removed-inactive marker, `SelfEvicted` classification | Ported MDK `realize_self_eviction` state-derived-obligation model; identified exact marmot-ts insertion points (`ingest.ts` `removedFromGroup` branch, `MarmotGroup` load path, `send()` chokepoint)                                                                                                                                                                                                                          |
| CONV-03               | State notifications attributed to `commit_digest`, withdrawn on rewind supersession including marker clear        | Ported MDK's `GroupStateInvalidated`/`SupersededByBranchSelection` pattern and `DeliveredPayloadLedger` as the direct structural template; found the exact rewind call sites (`#applyForkResolution`) that need the parallel ledger                                                                                                                                                                                           |
| CONV-04               | Verify-first: own published+confirmed commit never rolled back for a same-epoch sibling                           | Read MDK's `PrevalidatedOwnCommits`/own-commit-stamp mechanism (needed because OpenMLS cannot reprocess own commits) and confirmed marmot-ts's `RetainedHistoryStore`/`ForkRecovery` architecture is **structurally different** and does not need an equivalent shim — documented the two invariants (own-commit inclusion, dual-ordering determinism) and exactly where each is enforced in `fork-recovery.ts` / `ingest.ts` |
| </phase_requirements> |

## Summary

This phase ports three MDK Rust legality checks into marmot-ts and closes a verify-first convergence gap. All four
pieces are pure ports/analysis against code already read in this session — no new libraries, no external research
needed.

**WIRE-03 (component integrity)** and **CONV-01 (admin/leaf coupling)** both hinge on the same architectural fact:
MDK's OpenMLS gives it a `StagedCommit` object that exposes the **resulting** `GroupContext` _before_ merge, so its
validators run against `(mls_group, staged)` pre-merge. ts-mls has no staged-commit concept — `processMessage`
returns the fully-applied `newState` in one step, and its `IncomingMessageCallback` (the only pre-apply hook) sees
proposals but never the resulting `GroupContext`. The correct port is therefore **not** "run inside the admin
callback" — it is "call `processMessage` once, then validate `(parentState, result.newState, incoming.proposals)`
before committing that result to canonical state (`ctx.setState`/`ctx.recordCommit`)." The admin callback captures
`incoming.proposals` (needed for the AppDataUpdate-attribution rule) as a side channel during the call; the pure
validators then run against the state diff. On rejection, the engine must not call `ctx.setState` — this is exactly
the same shape as the existing `actionTaken === "reject"` branch in `ingest.ts`, just gated by a second check after
`processMessage` returns rather than inside the callback.

**CONV-02/CONV-03 (SelfEvicted realization + notification withdrawal)** are additive: marmot-ts already detects the
`removedFromGroup` tombstone on both the direct-commit and fork-resolution paths in `ingest.ts`, and already has
`MarmotGroup`'s `removed` event and `#rejectQueuedOutbound`. What's missing is (1) a persisted marker distinct from
the MLS tombstone so realization is state-derived and idempotent across restarts, (2) a `SelfEvicted`
`SkippedIngestResult` reason that short-circuits ingest before decrypt, and (3) a notification ledger keyed by
`commitDigest` — a straightforward structural sibling of the already-shipped `DeliveredPayloadLedger`.

**CONV-04 (own-confirmed-commit protection)** is verify-first per D-15, and this research's main finding is that
**marmot-ts likely does not need MDK's `PrevalidatedOwnCommits` mechanism at all**. That mechanism exists in MDK
solely because OpenMLS's `process_message` _cannot_ re-process a commit the local device authored (a stateful
constraint of the Rust MLS crate) — so MDK's convergence layer stamps own commits at confirm time and reconstructs
their branch from the stamp instead of replaying them. ts-mls's `processMessage` is a pure function over an explicit
`ClientState` argument with no such restriction, and marmot-ts's `RetainedHistoryStore.record()` already stores every
applied commit — own-authored (via `confirmPublished`) or inbound — identically, keyed by source epoch. `ForkRecovery`
replays `retained.appliedCommitsBetween(forkEpoch, tipEpoch)` (which includes own commits) plus the incoming pool
uniformly through `processMessage` again to build every candidate branch, so an own commit's branch is a normal
candidate, not a special case. The two properties D-16 requires should already hold **by construction**; this phase's
job is writing the native tests that prove it and fixing anything the tests reveal (verify-first, no code change
assumed).

**Primary recommendation:** Build one pure validator module (D-01) that both WIRE-03 and CONV-01 checks live in (or
sibling modules per Claude's discretion), call it from a single shared post-`processMessage`, pre-`setState` chokepoint
reused across `ingest.ts`'s direct-commit branch, `fork-recovery.ts`'s `#buildBranches` replay step, and
`group-engine.ts`'s `send()` staging step — mirroring MDK's "same helper on every seam" convention exactly. Then
layer CONV-02/03's marker + ledger on top of the already-existing tombstone detection, and close CONV-04 with two
targeted Vitest tests plus (if they fail) a minimal fix.

## Architectural Responsibility Map

| Capability                                                              | Primary Tier                                                                                          | Secondary Tier                                                                          | Rationale                                                                                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| App-component integrity validation (attribution rule)                   | `src/core` (pure validator)                                                                           | `src/engine` (seam wiring)                                                              | Zero-I/O protocol logic per D-01; engine is the only tier with access to `ClientState`/`processMessage` results to call it from |
| Admin/leaf coupling validation                                          | `src/core` (pure validator)                                                                           | `src/engine` (seam wiring)                                                              | Same split as above; account→leaves mapping already lives in `src/core/group-members.ts`                                        |
| Admin-policy auto-coupling (splice AppDataUpdate into a removal commit) | `src/engine` (`group-engine.ts` `send()`)                                                             | `src/client` (`proposeRemoveUser` stays a plain proposal builder, D-06)                 | MDK does this in its send path, not its proposal layer; marmot-ts's commit-staging step is the direct analog                    |
| AdminDepletion guard                                                    | `src/engine` (`group-engine.ts` `send()`)                                                             | —                                                                                       | Must run before staging, alongside auto-coupling; no core dependency beyond the pure validators                                 |
| SelfEvicted realization (marker set/clear, `selfRemoved` notification)  | `src/engine` (`ingest.ts` commit branch + load-time check)                                            | `src/client` (`MarmotGroup` load path calls the realize check)                          | Realization is state-derived per spec; the engine owns canonical state, the client owns the persisted marker's storage location |
| Removed-inactive outbound block                                         | `src/engine` (`group-engine.ts` `send()` throw, D-14)                                                 | `src/client` (`#rejectQueuedOutbound`, already exists)                                  | One chokepoint per D-14; client-side queue rejection is a separate, already-shipped concern                                     |
| StateNotification model + commit-digest ledger                          | `src/engine` (new ledger sibling to `DeliveredPayloadLedger`)                                         | `src/core` (`StateNotification` type + `commitDigest` already in `core/convergence.ts`) | Notifications are engine-produced per accepted commit; the digest primitive is already core                                     |
| Convergence/fork-recovery own-commit + dual-ordering properties         | `src/engine` (`fork-recovery.ts`, `retained-store.ts`, `core/convergence.ts` `selectCanonicalBranch`) | —                                                                                       | Entirely engine + pure-core scoring; no new architecture needed, only verification                                              |

## Standard Stack

This phase adds **no new external dependencies**. It is a pure port into the existing `ts-mls` + `@noble/hashes`
stack already used by `src/core` and `src/engine`.

### Core

| Library         | Version                       | Purpose                                                                             | Why Standard                                     |
| --------------- | ----------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| `ts-mls`        | local workspace (`./ts-mls`)  | `processMessage`, `ClientState`, `IncomingMessageCallback`, `GroupContextExtension` | Already the project's MLS engine; no alternative |
| `@noble/hashes` | ^2.2.0 (already a dependency) | `sha256` for `commitDigest` (`src/core/convergence.ts`, already exists)             | Already used project-wide for all hashing        |

### Supporting

No new supporting libraries. All new code is pure TypeScript over existing types (`ComponentData`,
`GroupContextExtension`, `ClientState`, `MlsMessage`).

### Alternatives Considered

| Instead of                                                            | Could Use                                              | Tradeoff                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure-function validator called explicitly at each seam (chosen, D-01) | Folding validation into `IncomingMessageCallback`      | Rejected by the architecture itself: the callback runs pre-apply and never sees the resulting `GroupContext`, so the attribution/coupling checks cannot be expressed there for the integrity rule (they can partially for the "who may commit" gate, which already lives there and is unaffected) |
| `RejectedIngestResult.reason` discriminator (chosen, D-03)            | A new top-level `IngestResult` kind per rejection type | Rejected — breaks the `kind`↔`Disposition` exhaustive-switch correspondence documented in `ingest-disposition.ts` and CLAUDE.md's "Established Patterns"                                                                                                                                          |

**Installation:** None — no new packages.

**Version verification:** N/A — no new packages to verify against a registry. `ts-mls` is a local workspace package
(`./ts-mls`, not npm); its API surface used here (`ClientState`, `processMessage`, `IncomingMessageCallback`,
`GroupContextExtension`, `ComponentData`) was confirmed present by direct source read
(`ts-mls/src/incomingMessageAction.ts`, `ts-mls/src/processMessages.ts`, `src/core/components/dictionary.ts`).

## Package Legitimacy Audit

**Not applicable — this phase installs no external packages.** All work is internal to `src/core`, `src/engine`, and
`src/client` using already-vetted, already-installed dependencies (`ts-mls` workspace package, `@noble/hashes`).

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                    SEND (local intent)                  INBOUND (peer commit)              CONVERGENCE/REPLAY (fork)
                    ────────────────────                 ─────────────────────              ──────────────────────────
 caller → send({kind:"commit", ...})        peer commit envelope arrives           forkPool commit (past/sibling epoch)
        │                                          │                                          │
        ▼                                          ▼                                          ▼
 [D-05] auto-couple: derive resulting        ingest.ts commit branch:                 ForkRecovery#buildBranches:
 admins = leaves − removed; splice           processMessage(state, message,          for each candidate commit in pool:
 admin-policy AppDataUpdate if any            adminCallback) → captures               processMessage(state, message,
 admin loses last leaf                        incoming.proposals as side channel       adminCallback) → captures
        │                                          │                                    incoming.proposals
        ▼                                          ▼                                          │
 [D-07] AdminDepletion guard:                 result.kind === "newState"                       ▼
 throw before staging if coupling            result.actionTaken === "reject"?          next.kind === "newState"
 would empty admins                           → yield rejected (admin-policy)          && actionTaken !== "reject"?
        │                                          │ no                                        │
        ▼                                          ▼                                          ▼
 createCommit(state, extraProposals)    ┌─── VALIDATE (shared pure core, D-01) ──────────────────────────┐
        │                               │  validateAppComponentIntegrity(                                │
        ▼                               │    parentState.groupContext.extensions,                        │
 [D-01/D-02] VALIDATE (same pure        │    newState.groupContext.extensions,                            │
 core as inbound/replay) against        │    incoming.proposals (AppDataUpdate ops),                      │
 (state, newState, extraProposals)      │    requiredIds = getAppComponents(parentState.extensions))       │
        │ invalid → throw                │  validateAdminLeafCoupling(                                    │
        │ (UsageError, before wrap)      │    parentState admins, resulting admins from newState,          │
        ▼                               │    removed/added leaf accounts)                                 │
 wrap + return SendResult               └───────────────────────┬─────────────────────────────────────────┘
 (unchanged shape)                                              │
                                          inbound invalid → yield rejected     replay invalid → drop candidate edge
                                          {reason: 'component-integrity'       (commit never creates a branch;
                                           | 'admin-leaf-coupling'}            D-04: no grandfathering)
                                                  │ valid                              │ valid
                                                  ▼                                    ▼
                                          ctx.setState(newState)              branch scored by selectCanonicalBranch
                                          ctx.recordCommit(...)               (pure, core/convergence.ts — unaffected
                                          notifications derived + attached    by this phase except as an input filter)
                                          to processed IngestResult
                                          (D-10/D-11)
                                                  │
                                                  ▼
                                   removedFromGroup tombstone? (existing detection)
                                          │ yes                        │ no
                                          ▼                            ▼
                          [D-12] set removed-inactive marker    normal processed/notifications flow
                          emit selfRemoved notification
                          yield removed (existing)
                                          │
                                          ▼
                          later input for this group (any seam)
                          [D-13] short-circuit BEFORE peel/decrypt
                          → skipped {reason: 'self-echo'... 'self-evicted'}

                          REWIND (fork supersedes an applied commit, incl. own)
                          ──────────────────────────────────────────────────
                          #applyForkResolution (group-engine.ts, existing)
                                          │
                                          ▼
                          [CONV-03] StateNotificationLedger.invalidatedByRewind(
                                       forkEpoch, canonicalTags)
                                     → withdrawn notifications + stateInvalidated result
                                     → if withdrawn set included a selfRemoved marker,
                                       CLEAR the removed-inactive marker (D-12)
```

### Recommended Project Structure

```
src/core/components/
├── integrity.ts          # NEW — pure WIRE-03 validator (D-01); optionally also
│                          #   houses the admin/leaf coupling validator (Claude's
│                          #   discretion vs. putting it in admin-policy.ts)
├── admin-policy.ts        # existing codec; add pure coupling validator here if
│                          #   not colocated in integrity.ts
├── dictionary.ts           # existing — getComponentData/getAppComponents reused
│                          #   as the "requiredIds"/"currentExtensions" source
└── group-members.ts        # existing (src/core/, not src/core/components/) —
                            #   getPubkeyLeafNodeIndexes reused for D-08

src/engine/
├── admin-policy.ts         # existing IncomingMessageCallback; extend to also
│                          #   capture incoming.proposals for the seam wiring
│                          #   below (side channel, not a validation change)
├── ingest.ts                # inbound seam: call validators between
│                          #   processMessage and ctx.setState; SelfEvicted
│                          #   short-circuit added near the top of the loop
├── fork-recovery.ts          # convergence/replay seam: same validators inside
│                          #   #buildBranches' explore() before accepting a
│                          #   candidate edge
├── group-engine.ts           # send seam: auto-couple + AdminDepletion guard +
│                          #   integrity validation in the "commit" case;
│                          #   removed-group outbound throw (D-14) at the top
│                          #   of #sendInner; realize-on-load call in the
│                          #   constructor or an explicit init step
├── state-notifications.ts    # NEW — StateNotification type + Ledger class
│                          #   (sibling to delivered-payloads.ts)
└── types.ts                  # extend RejectedIngestResult (reason), add
                            #   notifications? to ProcessedIngestResult, add
                            #   'self-evicted' to SkippedIngestResult.reason,
                            #   add a new stateInvalidated IngestResult variant

src/core/
└── inbound.ts                # add SelfEvicted: inputCategories.staleEpoch to
                            #   the named-outcome map (mirrors BeyondAnchor)

src/client/group/
└── marmot-group.ts           # load-path realize-on-load call; removed-inactive
                            #   marker storage (new sibling key in the existing
                            #   GenericKeyValueStore, or group metadata)
```

### Pattern 1: The pre/post-apply reconciliation seam (WIRE-03 + CONV-01 core mechanism)

**What:** MDK validates against a `StagedCommit`'s already-computed resulting `GroupContext`, pre-merge. ts-mls has
no staged-commit concept: `processMessage` both computes and returns the resulting state in one call, and its only
pre-apply hook (`IncomingMessageCallback`) cannot see that resulting state. The port therefore restructures "when do
we validate" rather than "what do we validate": call `processMessage` once (as today), capture the commit's own
`AppDataUpdate` proposals via a side channel during the callback invocation, then — **before** committing the
returned `newState` to canonical state — run the pure validators against `(parentState, newState, capturedProposals)`.
On failure, treat exactly like the existing `actionTaken === "reject"` branch: don't call `ctx.setState`/
`ctx.recordCommit`; yield `rejected` (inbound) or throw (send) or drop the candidate edge (replay).

**When to use:** Every one of the three seams (send, inbound, convergence/replay) that produces a `ProcessMessageResult`
with `kind: "newState"` from a commit.

**Example — capturing the commit's own AppDataUpdate proposals via the callback side channel:**

```typescript
// src/engine/admin-policy.ts (extended) or a new wrapping callback
// Source: ts-mls/src/incomingMessageAction.ts (IncomingMessageCallback shape) +
// refs/mdk/crates/cgka-engine/src/app_components.rs validate_app_component_integrity_for_staged_commit
// (the "update_ops" map keyed by component id, built from queued AppDataUpdate proposals)
export function createValidatingAdminCallback(args: {
  ratchetTree: ClientState["ratchetTree"];
  adminPubkeys: string[];
  ciphersuiteId: number;
  onCapturedProposals: (proposals: ProposalWithSender[]) => void;
}): IncomingMessageCallback {
  const inner = createAdminCommitPolicyCallback(args); // existing MIP-03 gate, unchanged
  return (incoming) => {
    if (incoming.kind === "commit")
      args.onCapturedProposals(incoming.proposals);
    return inner(incoming);
  };
}
```

**Example — the post-apply validation gate (inbound seam shape; send/replay mirror it):**

```typescript
// src/engine/ingest.ts (conceptual — exact call site inside the existing
// `if (result.kind === "newState")` branch, before `ctx.setState`)
let capturedProposals: ProposalWithSender[] = [];
const result = await processMessage({
  context: { cipherSuite: ctx.ciphersuite, authService: marmotAuthService, externalPsks: {} },
  state: ctx.getState(),
  message,
  callback: createValidatingAdminCallback({
    ...adminArgs,
    onCapturedProposals: (p) => { capturedProposals = p; },
  }),
});
if (result.kind === "newState" && result.actionTaken !== "reject") {
  const parentState = ctx.getState();
  const violation =
    validateAppComponentIntegrity({
      currentExtensions: parentState.groupContext.extensions,
      resultingExtensions: result.newState.groupContext.extensions,
      appDataUpdateOps: capturedProposals,
      requiredIds: getAppComponents(parentState.groupContext.extensions) ?? [],
    }) ??
    validateAdminLeafCoupling({ parentState, resultingState: result.newState, removedProposals: capturedProposals });
  if (violation) {
    ctx.dedup.remember(message);
    yield { kind: "rejected", result, envelope, message, reason: violation.reason };
    continue;
  }
  // ...existing setState/recordCommit/processed path
}
```

### Pattern 2: The MDK attribution rule (WIRE-03 validator body)

**What:** Every dictionary entry that differs between `currentExtensions` and `resultingExtensions` — added, changed,
or removed — must be justified by one of the commit's own `AppDataUpdate` proposals whose resulting value matches
exactly (`None`/absent = a `Remove` op). The `app_data_dictionary` extension itself may never disappear if it was
present before. The protected set (may never be silently dropped) is the current epoch's required-component-id list
(`getAppComponents(currentExtensions)`) **plus** the `app_components` id itself (`0x0001`).

**When to use:** WIRE-03, all three seams, via Pattern 1's gate.

**Example (ported directly from `refs/mdk/crates/cgka-engine/src/app_components.rs`
`validate_app_component_integrity_for_staged_commit`, lines 345-410):**

```typescript
// src/core/components/integrity.ts
// Source: refs/mdk/crates/cgka-engine/src/app_components.rs (ported algorithm)
export interface AppDataUpdateOp {
  componentId: AppComponentId;
  /** undefined = Remove operation */
  data: Uint8Array | undefined;
}

export function validateAppComponentIntegrity(args: {
  currentExtensions: GroupContextExtension[];
  resultingExtensions: GroupContextExtension[];
  appDataUpdateOps: AppDataUpdateOp[];
  requiredIds: AppComponentId[]; // from the CURRENT epoch's app_components entry
}): { reason: "component-integrity"; detail: string } | undefined {
  const current = getAppDataDictionary(args.currentExtensions); // may be undefined
  const resulting = getAppDataDictionary(args.resultingExtensions);
  if (current !== undefined && resulting === undefined) {
    return {
      reason: "component-integrity",
      detail: "resulting GroupContext drops app_data_dictionary",
    };
  }
  const protectedIds = new Set(args.requiredIds);
  protectedIds.add(APP_COMPONENTS_COMPONENT_ID);
  for (const id of protectedIds) {
    const before = current?.find((c) => c.componentId === id);
    const after = resulting?.find((c) => c.componentId === id);
    if (before !== undefined && after === undefined) {
      return {
        reason: "component-integrity",
        detail: `drops required component 0x${id.toString(16)}`,
      };
    }
  }
  // ops indexed by componentId → list of allowed resulting byte arrays (undefined = Remove)
  const opsByComponent = new Map<AppComponentId, (Uint8Array | undefined)[]>();
  for (const op of args.appDataUpdateOps) {
    const list = opsByComponent.get(op.componentId) ?? [];
    list.push(op.data);
    opsByComponent.set(op.componentId, list);
  }
  const allIds = new Set(
    [...(current ?? []), ...(resulting ?? [])].map((c) => c.componentId),
  );
  for (const id of allIds) {
    const before = current?.find((c) => c.componentId === id)?.data;
    const after = resulting?.find((c) => c.componentId === id)?.data;
    if (bytesEqual(before, after)) continue; // unchanged
    const allowed = opsByComponent.get(id);
    const backed = allowed?.some((candidate) => bytesEqual(candidate, after));
    if (!backed) {
      return {
        reason: "component-integrity",
        detail: `changes component 0x${id.toString(16)} outside AppDataUpdate`,
      };
    }
  }
  return undefined;
}
```

### Pattern 3: Auto-coupling + AdminDepletion on send (CONV-01)

**What:** When a removal commit is staged and it would drop the last leaf of any admin account, splice an
admin-policy `AppDataUpdate` dropping exactly those accounts' keys into the **same commit**, computed from _current
leaves minus this commit's removed leaves_, mapped to accounts via credential (D-08). If the resulting admin set
would be empty, throw an `AdminDepletion` error **before** staging (D-07) rather than let the coupling validator
reject after the fact.

**When to use:** `MarmotGroupEngine.send()`'s `"commit"` case, specifically when the caller's `extraProposals`
resolve to one or more `Proposal.remove`/leaf removals (i.e. any removal-shaped commit, not only a dedicated
"remove" intent — mirrors MDK doing this generically in its `do_send_remove_members`, but marmot-ts's `send()` takes
arbitrary composed proposals, so this must run generically over whatever removal proposals end up in
`allProposals`, not only ones built by `proposeRemoveUser`).

**Example (ported from `refs/mdk/.../send.rs` `do_send_remove_members`, lines 404-450):**

```typescript
// Conceptual — inside MarmotGroupEngine's "commit" send case, after
// allProposals is assembled and before createCommit is called.
const removedLeaves = leavesRemovedBy(allProposals); // Remove + SelfRemove leaf indices
const survivingAccounts = accountsSurviving(this.state, removedLeaves); // credential-based, D-08
const currentAdmins = groupData.adminPubkeys;
const resultingAdmins = currentAdmins.filter((pk) => survivingAccounts.has(pk));
if (
  resultingAdmins.length === 0 &&
  currentAdmins.length > 0 &&
  removedLeaves.size > 0
) {
  throw new AdminDepletionError(/* ... */); // D-07 — before any staging
}
if (resultingAdmins.length !== currentAdmins.length) {
  allProposals.push({
    proposalType: defaultProposalTypes.appDataUpdate,
    appDataUpdate: {
      componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
      data: encodeAdminPolicyV1(resultingAdmins),
    },
  }); // D-05 — same commit
}
```

### Pattern 4: State-derived removal realization (CONV-02)

**What:** Realization is not a one-shot side effect of applying the removing commit — it is a state-derived
obligation checked (a) immediately when a commit applies and removes the local leaf (existing tombstone detection),
AND (b) on group load, in case a prior process exited between commit-apply and marker persistence. Both call sites
share one `realizeIfNeeded(state, marker)` function: if `state` records our removal and `marker` is unset, emit
`selfRemoved` + persist the marker; otherwise no-op. This exactly mirrors MDK's `realize_self_eviction`, called both
from the `is_active()` gate at the top of `ingest_group_message` and from the `UseAfterEviction` processing-error
arm.

**When to use:** CONV-02, at the `ingest.ts` `removedFromGroup` branch (already detects the tombstone) and at
`MarmotGroup` construction/load (new call).

### Anti-Patterns to Avoid

- **Validating inside the `IncomingMessageCallback`:** The resulting `GroupContext` does not exist yet when the
  callback runs (ts-mls has no staged-commit split). Any attempt to validate WIRE-03/CONV-01 there will either be
  wrong (validating the wrong state) or impossible (the data isn't there). Validate after `processMessage` returns,
  before committing the result (Pattern 1).
- **Dedup-by-`event.id` for the folded `rejectedEvents` todo:** explicitly rejected by the user — it reopens the
  WR-01 censorship bug where a same-id forgery could suppress a later genuine event with the same id.
- **Grandfathering previously-accepted violating commits in the history tree (D-04 rejected this):** don't special-case
  the replay seam to skip validation for already-recorded edges — uniform enforcement across all three seams is the
  literal acceptance criterion.
- **A new top-level `IngestResult` kind for `SelfEvicted` or for rejection reasons:** breaks the `kind`↔`Disposition`
  exhaustive switch (`ingest-disposition.ts`). Use the `reason`/discriminator fields instead (D-03, D-13).
- **Building any MDK-style `PrevalidatedOwnCommits`/commit-stamping shim for CONV-04:** almost certainly unneeded —
  see "Convergence/CONV-04 findings" below. Do not add this complexity unless the native tests written in this phase
  actually demonstrate marmot-ts rolls back its own commit or breaks dual-ordering.

## Don't Hand-Roll

| Problem                                   | Don't Build                                              | Use Instead                                                                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SHA-256 commit digest                     | A new hashing helper                                     | `commitDigest()` in `src/core/convergence.ts` (already exists, already used by `fork-recovery.ts`/`ingest.ts`)                                                       | CONV-03's attribution key is already implemented and tested                                                                                                                                                                                                                                                                               |
| Account→leaves mapping for admin-coupling | New tree-walking code                                    | `getPubkeyLeafNodeIndexes` (`src/core/group-members.ts`)                                                                                                             | Already does exactly the pubkey→leaf-index mapping D-08 needs                                                                                                                                                                                                                                                                             |
| Rewind-triggered invalidation bookkeeping | A bespoke notification-withdrawal mechanism from scratch | Mirror `DeliveredPayloadLedger` (`src/engine/delivered-payloads.ts`) structurally — same `record`/`invalidatedByRewind(forkEpoch, canonicalTags)`/`pruneBelow` shape | The spec explicitly calls state-notification withdrawal "the counterpart of app-payload invalidation"; the existing ledger is the tested template for exactly this rewind-scoping logic                                                                                                                                                   |
| Deterministic same-epoch commit ordering  | New comparator logic                                     | `CommitOrderingKey`/`compareCommitOrderingKeys` (`src/core/convergence.ts`, already used by `ingest.ts`'s `sortPeeledCommits`)                                       | Already implements the spec's "Same-epoch races" rule byte-for-byte; CONV-04's dual-ordering property depends on this pre-sort already existing — verify it, don't reimplement it                                                                                                                                                         |
| Component dictionary reads                | Ad-hoc extension array scans                             | `getComponentData`/`getAppComponents`/`getAdminPolicy` (`src/core/components/dictionary.ts`)                                                                         | Already the single source of truth for reading dictionary entries; the integrity validator should consume `GroupContextExtension[]` directly (as MDK does with its `AppDataDictionary`) rather than re-deriving through these typed accessors, to stay generic over unknown component ids per the spec's "Unknown Data" preservation rule |

**Key insight:** Every piece of machinery this phase needs except the two new pure validators and the notification
ledger already exists in the codebase in a directly reusable or directly analogous form. The engineering risk is
almost entirely in _where_ to call things (the pre/post-apply reconciliation seam), not in _what_ to build.

## Common Pitfalls

### Pitfall 1: Treating `IncomingMessageCallback` as if it were MDK's `StagedCommit`

**What goes wrong:** A naive port tries to run the integrity/coupling checks inside `createAdminCommitPolicyCallback`,
because that's where MDK's admin-authorization-equivalent check (`require_admin_for_staged_commit`) conceptually
lives. But `incoming.proposals` there is pre-apply — there's no resulting `GroupContext` to diff against.
**Why it happens:** MDK's code literally structures the validators as taking `(mls_group, staged: &StagedCommit)`,
which reads as "the commit, before it's applied" — an easy false cognate for "the pre-apply callback."
**How to avoid:** Follow Pattern 1 — validate after `processMessage` returns `newState`, using the callback only as a
side channel to capture `incoming.proposals` for the attribution rule.
**Warning signs:** A validator function that only receives `ClientState` (pre-commit) and proposals, with no way to
express "the resulting dictionary."

### Pitfall 2: Re-deriving `requiredIds` from the wrong epoch

**What goes wrong:** WIRE-03's protected set is the **current** (pre-commit) epoch's required-component-id list, not
the resulting one — because the whole point is detecting an out-of-band drop of something that WAS required.
**Why it happens:** It's tempting to read `requiredIds` off `resultingExtensions` since that's "the new state."
**How to avoid:** Always derive `requiredIds` via `getAppComponents(currentExtensions)` — the pre-commit dictionary —
mirroring MDK's `required_app_components_of_group(mls_group)` call, which reads the **live** (pre-merge) group, not
the staged one.
**Warning signs:** A validator signature that takes only one `extensions` argument instead of both current and
resulting.

### Pitfall 3: Admin/leaf coupling evaluated only when the commit carries admin-policy bytes

**What goes wrong:** Skipping the coupling check when a removal commit carries no `AppDataUpdate` for
`GROUP_ADMIN_POLICY_COMPONENT_ID` — but the spec is explicit: "When a commit carries no admin-policy update, the
resulting epoch's admin set is the prior epoch's admin set carried forward, and the check is evaluated against that
carried-forward set" (`admin-policy-v1.md` "Validation"). A membership-only removal that de-leafs an admin without
touching admin-policy bytes must still be rejected.
**Why it happens:** It's easy to gate the check on "did this commit touch the admin-policy component," which is the
wrong trigger — the trigger is "did this commit change the member leaf set OR this component's state."
**How to avoid:** Run the coupling check on every commit that changes membership, resolving the resulting admin set
from the resulting `AppDataUpdate` bytes if present, else the carried-forward (pre-commit) admin set — exactly
mirroring MDK's `validate_admin_leaf_coupling_for_staged_commit`'s `staged_admin_bytes` fallback to
`admins_of_group(mls_group)`.
**Warning signs:** A coupling validator invoked only from inside an `AppDataUpdate`-specific code path rather than
unconditionally alongside every commit-applying seam.

### Pitfall 4: SelfRemove triggering the coupling rule

**What goes wrong:** The coupling rule (`admin-policy-v1.md`) explicitly states "SelfRemove never triggers the
coupling rule" — because a departing admin is required to have already dropped itself from `admins` in an _earlier_
commit before it may SelfRemove (enforced by `createAdminCommitPolicyCallback`'s existing
`AdminCannotSelfRemove`-style check). If the new coupling validator naively treats every leaf-removing commit
(including SelfRemove-only ones) as subject to the auto-couple/depletion logic, it will double-guard a case the
existing admin-self-remove check already handles, or worse, misfire on a commit shape a non-admin is allowed to
submit.
**Why it happens:** SelfRemove and admin-initiated Remove both remove a leaf; conflating "leaf removed" with "coupling
applies" ignores the spec's explicit carve-out.
**How to avoid:** D-05's auto-coupling logic is specifically for the **send** path building a **Remove**-shaped
commit (an admin removing someone else); it does not apply to the local device's own `selfUpdate`/SelfRemove send
path. The **validation** side (D-09, all three seams) does need to handle a peer's SelfRemove-only commit correctly
— but per the spec, an admin's SelfRemove is already rejected by the existing sender-authorization check before
reaching the coupling validator, so the coupling validator only ever sees SelfRemoves from non-admins, which never
change the admin set and therefore trivially pass.
**Warning signs:** Coupling-validator test cases that don't distinguish "admin was removed by someone else" from
"admin self-removed" (the two paths have different, mutually exclusive validity gates per the spec).

### Pitfall 5: Assuming CONV-04 needs a `PrevalidatedOwnCommits`-equivalent shim

**What goes wrong:** Porting MDK's own-commit-stamping machinery wholesale (`OwnCommitConvergenceStamp`,
`stamp_processed_own_commit_record`, roll-forward-to-retained-anchor) into marmot-ts, even though the underlying
constraint that motivates it (OpenMLS refusing to re-process an own commit) does not exist in ts-mls.
**Why it happens:** D-15/D-16 explicitly point at these MDK PRs (#706/#723/#702/#724) as the reference; it's natural
to assume "port the mechanism" rather than "port the _property_."
**How to avoid:** Read `refs/mdk/crates/cgka-engine/src/openmls_projection.rs`'s `PrevalidatedOwnCommits` doc comment
closely — it says MLS **cannot** process a device's own commit through `process_message`, which is an OpenMLS-specific
constraint. `ts-mls`'s `processMessage` is a pure function of an explicit `ClientState`; nothing in marmot-ts's
`ForkRecovery.#buildBranches` special-cases "whose commit is this" — it replays `retained.appliedCommitsBetween(...)`
(which already includes own commits, recorded via `confirmPublished` → `#recordCommitNode` → `RetainedHistoryStore.record`)
plus the incoming `pool` uniformly. Write the D-16 tests first; only build new machinery if they fail.
**Warning signs:** Any Phase 3 task titled "port own-commit stamping" without a preceding failing test that
demonstrates marmot-ts actually rolls back an own commit.

## Reconciling pre/post-apply data (resolves the "Claude's Discretion" open question)

CONTEXT.md flags this explicitly as a planning concern: "ts-mls's `IncomingMessageCallback` exposes
`incoming.proposals` pre-apply, but the resulting `GroupContext` is only available post-apply." This research
resolves it with a concrete mechanism (Pattern 1 above): wrap the existing admin-verification callback so it also
captures `incoming.proposals` into a variable owned by the caller (the ingest/send/fork-recovery seam), then run the
pure validators immediately after `processMessage` resolves, using the captured proposals plus `parentState` (still
available — it's whatever `ctx.getState()` / `this.state` was before the call) and `result.newState`. No new ts-mls
API is needed; `ProcessMessageResult`'s `"newState"` variant already carries everything required
(`result.newState.groupContext.extensions` for the resulting dictionary; `result.actionTaken` to skip validation on
an already-rejected commit). The three seams differ only in what they do with a violation (throw / yield rejected /
drop the candidate edge), not in how they compute one — so the validators themselves should be seam-agnostic pure
functions per D-01, and each seam supplies its own thin adapter.

## Convergence / CONV-04 findings (verify-first)

Read in full: `refs/mdk/crates/cgka-engine/src/fork_recovery.rs`, `src/message_processor/ingest.rs`'s `WrongEpoch`
branch, and `src/openmls_projection.rs`'s `PrevalidatedOwnCommits`/`already_applied_commit_prefix` machinery, against
`src/engine/fork-recovery.ts`, `src/engine/retained-store.ts`, `src/engine/group-engine.ts`, `src/core/convergence.ts`.

**Why MDK needs the stamping shim, and why marmot-ts likely doesn't:**

- MDK: OpenMLS's `MlsGroup::process_message` cannot reprocess a commit the local device itself authored and already
  merged (a hard constraint of the underlying Rust MLS implementation, documented directly in the
  `PrevalidatedOwnCommits` rustdoc). So when MDK's stored-convergence layer needs to replay a candidate branch that
  contains the device's own already-applied commit, it cannot use ordinary replay for that segment — it must
  "pre-validate" the commit at confirm time (`own_commit_stamp`, capturing committer/priority/consumed-proposal-refs)
  and later reconstruct that segment by **rolling storage forward to the retained anchor snapshot at the commit's
  resulting epoch** instead of replaying the commit bytes.
- marmot-ts: `processMessage(context, state, message, callback)` is a pure function taking an explicit `ClientState`.
  Nothing prevents calling it again with the same commit `message` against the same `state` it was originally applied
  to — there is no "already processed this locally" flag inside `ClientState` that blocks replay. `ForkRecovery.
#buildBranches` (`src/engine/fork-recovery.ts`) builds every candidate by literally calling `processMessage` over
  `pool` (which is `[...ours, ...incoming]`, where `ours = retained.appliedCommitsBetween(forkEpoch, tipEpoch)` — see
  `resolveFork`), with no distinction between "a commit I authored" and "a commit a peer authored." Both were
  recorded into `RetainedHistoryStore` the same way: own commits via `MarmotGroupEngine.confirmPublished()` →
  `#recordCommitNode` → `retained.record(...)`; inbound commits via `ctx.recordCommit` in `ingest.ts`, which calls the
  identical `#recordCommitNode`. **There is exactly one recording path for both.**

**Property 1 (own commit not rolled back for a same-epoch sibling) — expected mechanism:** When a same-epoch sibling
arrives after we've already committed and confirmed our own commit at that epoch, it enters `forkPool` (in
`ingestEnvelopes`, `commitEpoch < currentEpoch`). `resolveFork` rebuilds branches from the shared fork-epoch root:
one branch is "our commit" (from `ours`, i.e. `retained.appliedCommitsBetween`), the other is "their commit" (from
`pool`). `selectCanonicalBranch` scores both with the _same_ deterministic comparator
(`compareBranchScores` — `core/convergence.ts`) regardless of which one we authored. Our commit wins or loses purely
on the spec's ordering rule (privileged-before-ordinary, then witness quorum, then depth, then lexicographically
lower committer/digest) — **never** because it's "ours." This is spec-correct (`convergence.md` "Branch selection"
lists no "prefer own commit" rule) and appears to already be what MDK converges to as well — MDK's own-commit
protection is a _plumbing_ necessity (own commits must be materializable as candidates at all, since OpenMLS can't
replay them), not a _scoring_ preference. **What the native test should assert:** given an own commit at epoch N and
a losing sibling at epoch N (lower priority, or same priority but higher digest), after ingesting the sibling the
engine's live state is still our commit's `newState` — i.e., the sibling never becomes canonical, but _purely because
its ordering key loses_, not through any special-casing.

**Property 2 (dual-ordering — same commits, opposite delivery order, same branch selected):** `ingestEnvelopes`
already sorts commits into a canonical order (`sortPeeledCommits`, `core/convergence.ts`'s `compareCommitOrderingKeys`
— sourceEpoch then commitDigest) **before** classifying them into `forkPool`, independent of the array order the
caller passed in. `#buildBranches`'s DFS (`explore()`) iterates `candidatesAt(state)` which iterates `pool` in a
fixed order derived from that same array — so two engines fed `[commitA, commitB]` vs. `[commitB, commitA]` should
reach the sort in the same relative order and therefore the identical candidate-branch set and the identical
`selectCanonicalBranch` result (score comparison itself is symmetric/order-independent; the only order-sensitivity is
the `>=` tie-break in `selectCanonicalBranch`'s `for` loop, which favors "later in the candidates array" on an exact
score tie — but `compareBranchScores`'s final tiebreak on `tipDigest` bytes means a genuine full tie only occurs for
byte-identical branches, i.e. the same commit, so this should not be order-observable in practice). **What the native
test should assert:** construct two `MarmotGroupEngine` instances from the same pre-fork state, ingest the same two
(or more) same-epoch competing commits in opposite array order across the two instances, and assert both land on the
same resulting `confirmationTag`.

**If either test fails:** per D-15/verify-first, only then design a minimal, targeted fix (not a full
`PrevalidatedOwnCommits` port) — the most likely gap, if any, would be in `sortPeeledCommits`'s scope (does it cover
every commit that reaches `forkPool`, including ones routed through `orphanPool`/tree-fed reconvergence, or only the
direct `ingestEnvelopes` pool-replay path?) or in `buildTreeBranchSet`'s structural (witness-free) tie-break basis
when two persisted fork branches score identically on load.

## Runtime State Inventory

Not applicable — this is not a rename/refactor/migration phase. Skipping per the trigger condition.

## Code Examples

### Widening `RejectedIngestResult` (D-03)

```typescript
// src/engine/types.ts (extend existing type)
// Source: CONTEXT.md D-03 + refs/marmot/foundation/errors.md (authorization_failed
// category is unchanged; this is an additive local-API discriminator only)
export type RejectedIngestResult<TEnvelope> = {
  kind: "rejected";
  result: ProcessMessageResult;
  envelope: TEnvelope;
  message: MlsMessage;
  /** Extensible; additive field, no disposition-mapping change (ingest-disposition.ts unaffected). */
  reason?: "admin-policy" | "component-integrity" | "admin-leaf-coupling";
};
```

### Adding `SelfEvicted` to the named-outcome map (D-13)

```typescript
// src/core/inbound.ts (extend existing map, mirrors BeyondAnchor/MissingRetainedAnchor)
// Source: refs/marmot/foundation/errors.md "Named convergence outcomes" table
//   | SelfEvicted | stale | stale_epoch | member-departure.md |
export const convergenceOutcomeToCategory = {
  BeyondAnchor: inputCategories.missingHistory,
  MissingRetainedAnchor: inputCategories.missingHistory,
  SelfEvicted: inputCategories.staleEpoch,
} as const satisfies Record<string, InputCategory>;
```

And in `types.ts`, extend `SkippedIngestResult.reason` with `"self-evicted"`; in `ingest-disposition.ts`, add a case
mapping `"self-evicted"` to `disposition.stale(inputCategories.staleEpoch)`.

### `StateNotification` shape (D-10) — mirroring `DeliveredAppPayload`'s field set

```typescript
// src/engine/state-notifications.ts (new)
// Source: CONTEXT.md D-10/D-11 + refs/mdk convergence.md "Applying the selected branch"
// (notification shape is implementation-defined; commit_digest attribution is the
// conformance requirement)
export type StateNotification =
  | {
      kind: "epochAdvanced";
      from: number;
      to: number;
      commitDigest: Uint8Array;
    }
  | { kind: "memberAdded"; pubkey: string; commitDigest: Uint8Array }
  | {
      kind: "memberRemoved";
      pubkey: string;
      actor?: string;
      commitDigest: Uint8Array;
    }
  | { kind: "componentChanged"; componentId: number; commitDigest: Uint8Array }
  | { kind: "selfRemoved"; commitDigest: Uint8Array }
  | { kind: "branchRecovered"; forkEpoch: number; commitDigest: Uint8Array };

// Ledger — structural sibling of DeliveredPayloadLedger (src/engine/delivered-payloads.ts)
export class StateNotificationLedger {
  #byDigest = new Map<string /* hex commitDigest */, StateNotification[]>();
  #epochByDigest = new Map<string, number>();
  record(
    digest: Uint8Array,
    epoch: number,
    notifications: StateNotification[],
  ): void {
    /* ... */
  }
  invalidatedByRewind(
    forkEpoch: number,
    canonicalDigests: ReadonlySet<string>,
  ): StateNotification[] {
    /* ... */
  }
  pruneBelow(epoch: number): void {
    /* ... */
  }
}
```

## State of the Art

| Old Approach                                                                                              | Current Approach                                                                                                     | When Changed                 | Impact                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No component-integrity or admin/leaf-coupling validation (marmot-ts as of Phase 2)                        | Both enforced pre-merge at all three commit seams                                                                    | This phase (WIRE-03/CONV-01) | Closes the two interop-breaking gaps `.planning/research/MDK-INTEROP.md` finding 1 and `SPEC-DELTAS.md` finding 4 flag — without this, marmot-ts silently accepts commits MDK rejects, causing a permanent fork |
| No SelfEvicted classification; removal only surfaced via the `removed` event on the commit that caused it | State-derived realization (marker + notification) checked on every load and on every later input for a removed group | This phase (CONV-02)         | Matches MDK's `realize_self_eviction` idempotent-obligation model instead of a fire-once side effect that can be missed across a restart                                                                        |

**Deprecated/outdated:** None — this phase introduces new required behavior; nothing it replaces was ever a
supported code path (CONV-01/02/03/WIRE-03 were all previously "MISSING" per the catchup review, not "old approach
X").

## Assumptions Log

| #   | Claim                                                                                                                                                                                                                                            | Section                                                | Risk if Wrong                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | marmot-ts's `RetainedHistoryStore`/`ForkRecovery` architecture does not need an MDK-style `PrevalidatedOwnCommits` shim, because ts-mls's `processMessage` can safely reprocess an own-authored commit via replay from an explicit `ClientState` | Convergence / CONV-04 findings                         | LOW-MEDIUM — this is the central verify-first hypothesis of the phase; D-15 already mandates writing native tests before trusting it, so a wrong assumption here is caught by the tests this phase requires anyway, not silently shipped |
| A2  | The `>=` tie-break in `selectCanonicalBranch`'s loop (`compareBranchScores(score, bestScore) >= 0`) never actually produces an order-dependent pick in practice, because a full score tie implies byte-identical `tipDigest` (same commit)       | Convergence / CONV-04 findings, Property 2             | LOW — if wrong, the D-16 dual-ordering test will directly surface it as a failure, which is exactly what D-15's verify-first protocol expects to catch                                                                                   |
| A3  | `sortPeeledCommits` in `ingest.ts` is applied to every commit that can reach `forkPool` in the current codebase (no bypass path via the ingestion pool / tree sweep that skips the sort)                                                         | Convergence / CONV-04 findings, "If either test fails" | LOW-MEDIUM — affects only the diagnosis of a test failure, not whether the tests themselves are correct; worth a quick grep-confirm during planning/implementation rather than blind trust                                               |

## Open Questions

1. **Exact module for the admin/leaf coupling validator: `integrity.ts` or `admin-policy.ts`?**
   - What we know: CONTEXT.md leaves this to Claude's discretion; both validators share the same
     pre/post-apply-reconciliation call site and are always invoked together at each seam.
   - What's unclear: Whether colocating them in one `integrity.ts` module (both are "resulting-epoch invariants")
     or splitting admin/leaf coupling into `admin-policy.ts` beside its codec (matching MDK's own file layout, where
     both validators live in the _same_ `app_components.rs` file regardless) is cleaner for future components.
   - Recommendation: Colocate both in `src/core/components/integrity.ts` — MDK itself keeps them in one file
     (`app_components.rs`), and Phase 4's vector harness will likely want to call both from one import.

2. **Where does the auto-coupling logic (D-05) detect "this commit contains a removal"?**
   - What we know: `MarmotGroupEngine.send()`'s `"commit"` case accepts arbitrary composed `extraProposals` /
     `proposalRefs` — a caller could build a removal via `proposeRemoveUser` (a `ProposalAction`), a raw
     `Proposal.remove`, or a `Proposal.selfRemove` reference. D-06 places the coupling logic in the commit-staging
     path specifically because arbitrary extra proposals may accompany a removal.
   - What's unclear: Whether "removal-shaped commit" detection should scan `allProposals` for any
     `defaultProposalTypes.remove` (by-reference Remove) entries only, or also fold in resolved `selfRemoveProposalType`
     references from `proposalRefs` (since a committer assembling a peer's SelfRemove into a commit is a distinct,
     non-auto-coupling-triggering case per Pitfall 4).
   - Recommendation: Scan for `defaultProposalTypes.remove` proposals specifically (mirrors MDK's `remove_proposals()`
     iteration in `validate_admin_leaf_coupling_for_staged_commit`); explicitly exclude `selfRemoveProposalType`
     entries from the "trigger auto-coupling" scan (they still count as "removed leaves" for the _survival_
     computation, matching MDK's `queued_proposals()` loop that folds in `Proposal::SelfRemove` for the leaf-removal
     set but not for triggering the depletion guard's error path — worth confirming against MDK's exact behavior
     during planning if a SelfRemove alone could theoretically deplete admins, which Pitfall 4 argues it structurally
     cannot).

3. **Persisted removed-inactive marker storage location (D-12, Claude's discretion).**
   - What we know: Must be distinct from the MLS `removedFromGroup` tombstone (already in `ClientState`), must be
     clearable on rewind supersession (CONV-03), and must survive restart (so realization is a load-time check, not
     only an ingest-time one).
   - What's unclear: Whether to add a field to the existing group metadata record `MarmotGroup` already persists
     (if one exists outside `ClientState`) or a new sibling key in the `GenericKeyValueStore<SerializedClientState>`
     store (parallel to how `rewindStore` is a separate `GenericKeyValueStore<Uint8Array>` per CLAUDE.md's Data Flow
     section).
   - Recommendation: A new sibling key in the same store keying scheme as `rewindStore` (separate
     `GenericKeyValueStore<boolean>` or similar), rather than overloading `ClientState`'s serialized bytes — keeps the
     marker readable/writable without a full state deserialize, and keeps `ClientState` itself exactly what ts-mls
     produces (no Marmot-specific fields grafted on).

## Environment Availability

Skipped — no external tool/service/runtime dependencies beyond the already-installed `ts-mls` workspace package and
Node/Vitest, all already verified present and working in Phases 1-2 of this milestone.

## Security Domain

`security_enforcement` is not set to `false` in `.planning/config.json`, so this section is included, scoped to what
actually applies to a protocol/commit-legality library phase (most web-app ASVS categories are not applicable).

### Applicable ASVS Categories

| ASVS Category         | Applies        | Standard Control                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2 Authentication     | No             | Not applicable — no user-facing auth surface in this library                                                                                                                                                                                                                                                                                                                                                               |
| V3 Session Management | No             | Not applicable                                                                                                                                                                                                                                                                                                                                                                                                             |
| V4 Access Control     | Yes            | This phase IS an access-control feature: WIRE-03/CONV-01 are commit-legality/authorization checks. Control: the shared pure validators (Pattern 1/2/3) enforced identically pre-merge on all three seams, matching MDK's "mirror every ingest invariant on every inbound seam" convention (`refs/mdk/crates/cgka-engine/CLAUDE.md`) — a guard added to only one seam is a documented bug class (mdk#707)                   |
| V5 Input Validation   | Yes            | All new inputs (commit's `AppDataUpdate` proposals, resulting `GroupContext` extensions) are validated via the canonical decoders already in `src/core/components/*` (e.g. `decodeAdminPolicyV1` enforces sorted/unique/non-empty 32-byte keys) before being compared; the integrity validator itself performs byte-exact comparison, never re-encodes or normalizes (mirrors the spec's "Unknown Data" preservation rule) |
| V6 Cryptography       | No new surface | `commitDigest` (SHA-256, `@noble/hashes`) is reused, not hand-rolled; no new key material or signing is introduced in this phase                                                                                                                                                                                                                                                                                           |

### Known Threat Patterns for this stack

| Pattern                                                                                                                                                                                                                             | STRIDE                             | Standard Mitigation                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component-stripping/tampering commit (a `GroupContextExtensions`-only commit that silently drops `app_data_dictionary` or rewrites admin-policy bytes outside a validated `AppDataUpdate`, freezing or hijacking group admin state) | Tampering / Elevation of Privilege | WIRE-03's integrity validator, enforced pre-merge at all three seams (this phase)                                                                                                        |
| Removal-without-policy-update commit leaving an admin key with no member leaf (a "ghost admin" that a future rejoin or repair flow could exploit, or that silently diverges two implementations' admin sets)                        | Tampering / Elevation of Privilege | CONV-01's coupling validator + auto-coupling on send (this phase)                                                                                                                        |
| A same-id forgery of an already-processed event suppressing delivery of a later genuine event with the same id (the folded `rejectedEvents` todo, WR-01)                                                                            | Denial of Service                  | Filter only on `!seen.has(event.id)` (trusted-only, post-verification dedup set); never dedup on the pre-verification rejected-events set by `event.id` (the folded todo's explicit fix) |
| Unbounded `Set<NostrEvent>` object-identity dedup pinning memory indefinitely under a hostile/high-volume relay (the folded `groupsmanager-rejectedevents-dos` todo)                                                                | Denial of Service                  | Drop `rejectedEvents` entirely per the folded todo's recommended fix; accept a redelivered malformed event may emit `rejected` twice (informational, not a protocol-safety concern)      |

## Sources

### Primary (HIGH confidence)

- `refs/mdk/crates/cgka-engine/src/app_components.rs` — `validate_app_component_integrity_for_staged_commit`,
  `validate_admin_leaf_coupling_for_staged_commit`, `reject_admins_without_member_leaf`,
  `reject_admin_self_remove_proposals`, `staged_commit_requires_admin` (read in full)
- `refs/mdk/crates/cgka-engine/src/message_processor/send.rs` — `do_send_remove_members` (full auto-coupling +
  `AdminDepletion` algorithm), `do_send_invite`, `prepare_self_remove_proposal` (read in full)
- `refs/mdk/crates/cgka-engine/src/message_processor/ingest.rs` — `ingest_group_message` inbound commit branch
  (integrity/coupling validator call sites, `realize_self_eviction` call sites, `is_active()` gate) (read ~1350
  lines)
- `refs/mdk/crates/cgka-engine/src/openmls_projection.rs` — `PrevalidatedOwnCommits`, `own_commit_stamp`,
  `stamp_processed_own_commit_record`, `already_applied_commit_prefix` (read ~1370 lines)
- `refs/mdk/crates/cgka-engine/src/fork_recovery.rs` — `ForkRecoveryManager::resolve` (same-epoch ordering-key
  comparator), snapshot lifecycle (read in full)
- `refs/mdk/crates/cgka-engine/CLAUDE.md` and `src/CLAUDE.md` — crate map, "mirror every ingest invariant on every
  inbound seam" convention
- `refs/marmot/app-components/admin-policy-v1.md` — full document (Active admins, Validation, Authorization,
  SelfRemove carve-out)
- `refs/marmot/protocol-core/member-departure.md` — full document (Realizing removal, Validation)
- `refs/marmot/protocol-core/convergence.md` — full document (Candidate branches, Branch selection, Same-epoch races,
  Applying the selected branch)
- `refs/marmot/foundation/errors.md` — full document (Input categories, Dispositions, Named convergence outcomes)
- `refs/marmot/app-components/README.md` — full document (Update Processing, Unknown Data, Default Authorization)
- `.planning/research/MDK-INTEROP.md` findings 1, 5, 6
- `.planning/research/SPEC-DELTAS.md` findings 4, 5, 6
- marmot-ts source (read in full or in the relevant sections): `src/engine/group-engine.ts`, `src/engine/ingest.ts`,
  `src/engine/fork-recovery.ts`, `src/engine/tree-convergence.ts`, `src/engine/admin-policy.ts`,
  `src/engine/retained-store.ts`, `src/engine/delivered-payloads.ts`, `src/engine/types.ts`,
  `src/engine/ingest-disposition.ts`, `src/core/convergence.ts`, `src/core/client-state.ts`,
  `src/core/components/dictionary.ts`, `src/core/components/admin-policy.ts`, `src/core/components/ids.ts`,
  `src/core/group-members.ts`, `src/core/inbound.ts`, `src/client/group/proposals/remove-member.ts`,
  `src/client/group/marmot-group.ts` (relevant sections), `src/client/groups-manager.ts` (relevant section),
  `ts-mls/src/incomingMessageAction.ts`, `ts-mls/src/processMessages.ts` (relevant sections)

### Secondary (MEDIUM confidence)

- None used — no web search was needed; all findings are grounded in direct source reads of authoritative
  repositories (`refs/mdk`, `refs/marmot`) and the current marmot-ts codebase.

### Tertiary (LOW confidence)

- None.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — no new dependencies; all APIs confirmed present by direct source read of `ts-mls`
- Architecture (pre/post-apply reconciliation seam): HIGH — derived directly from reading `ts-mls`'s
  `IncomingMessageCallback`/`processMessage` signatures against MDK's `StagedCommit`-based validators; the mismatch
  and its resolution are structural, not speculative
- Pitfalls: HIGH — every pitfall is grounded in an explicit spec sentence or an MDK code comment/doc quoted above
- CONV-04 findings: MEDIUM-HIGH — the core hypothesis (no stamping shim needed) is a strong architectural inference
  from reading both codebases, but is explicitly verify-first (D-15) and flagged as such (Assumption A1); this is by
  design, not a research gap

**Research date:** 2026-08-04
**Valid until:** No external dependency drift risk (no new packages); re-verify only if `ts-mls`'s workspace version
is bumped with API changes to `processMessage`/`IncomingMessageCallback`, or if `refs/mdk`/`refs/marmot` are updated
with new commits/spec sections in this area before planning executes.
