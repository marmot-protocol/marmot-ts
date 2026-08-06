---
phase: 04-feature-parity-conformance-vectors
type: reference-findings
created: 2026-08-06
sources:
  marmot: 4ad4ae2 (was 7f2f5fa — 4 commits)
  mdk: 790eb86 (was 3628ccc — 193 commits)
submodule_bump_commit: d8ab0ac
status: adopted-into-phase-4
---

# Phase 4: Reference Findings (marmot spec + MDK Rust)

Read from the submodules as pinned by `d8ab0ac`. Every citation below resolves at those
commits; re-verify after any later bump.

## 1. The Rust reference already solves CR-08 and CR-11 structurally

**This is the headline finding.** Phase 3 code review ran three rounds against
`src/engine/fork-recovery.ts`; each round found blockers in the previous round's fixes
(7 -> 4 -> 5), and CR-08 and CR-11 both survived a dedicated fix attempt as PARTIAL.

MDK does not have this defect class, because it does not do what we do.

`refs/mdk/crates/traits/src/message.rs:23`:

```rust
pub struct OwnCommitConvergenceStamp {
    /// This device's member identity — the authenticated committer.
    pub committer: MemberId,
    /// Authorization-aware ordering priority derived from the staged
    /// commit's shape at confirm time.
    pub priority: CommitOrderingPriority,
    /// Hex-encoded proposal references the commit consumed, in sorted order.
    pub consumed_proposal_refs: Vec<String>,
}
```

Its own doc comment (`message.rs:13-21`) states our exact failure mode:

> MLS cannot process a device's own commit through `process_message`, so after an engine
> restart the stored wire record is the ONLY source from which stored convergence can
> rebuild the own commit's branch-selection ordering key (priority + authenticated
> committer; the digest is recomputed from the stored bytes) and its consumed proposal
> references.

The stamp is captured **at confirm time, while the staged commit is still attached**, and
persisted as its own payload variant — `StoredMessagePayload::OwnCommitWire`
(`message.rs:69-72`), documented at `message.rs:53-56` as existing "so stored convergence
can treat it as a pre-validated candidate branch after a restart."

### Why this maps onto CR-08 and CR-11

| | marmot-ts today | MDK |
| --- | --- | --- |
| Proposal set for an own commit | **Reconstructed** at recovery time from the parent snapshot's `unappliedProposals` | **Recorded** once at confirm time |
| Authorization verdict | **Re-derived** independently by two seams that can disagree | **Stamped** at confirm time as `priority` |

- **CR-08** is reconstruction failing. `framedCommitProposalsWithSender` returns `undefined`
  at three sites (`src/engine/wire-format.ts:123`, `:125`, `:145`); round 3 additionally
  found a chained case where a preceding link's replay path yields
  `unappliedProposals === {}`, so a later own commit bundling by reference hits `:145`,
  falls through, throws per RFC 9420, and truncates our branch — letting a shallower
  competitor win. Recording the refs at confirm time makes every one of those paths
  structurally unreachable rather than individually guarded.
- **CR-11** is the two seams disagreeing. `#treeResolution` abandons on refusal (four
  `return undefined` sites, `src/engine/group-engine.ts:2041-2099`); the known-state path
  `continue`s and lets the truncated prefix compete, and skips the `confirmationTag`
  cross-check at `:2059-2068`. A stamped verdict has nothing to disagree with.

### Historical note

Phase 03-03 explicitly declined this. From STATE.md's decision log:

> fixed narrowly by reusing RetainedHistoryStore's already-known resulting state instead of
> replaying via processMessage, **without porting MDK's PrevalidatedOwnCommits stamping
> machinery**

CR-08 and CR-11 are the cost of that shortcut. Three incremental fix rounds have not paid
it off. Port the stamp.

## 2. New spec: the convergence assurance contract

`refs/marmot/protocol-core/convergence.md` gained ~261 lines in
`4ad4ae2` ("Define convergence assurance contract", #410). Load-bearing passages:

### Deferred, not dropped

> A commit whose parent is not available remains deferred while its authenticated MLS source
> epoch is inside or ahead of the rollback horizon.

with epoch-based expiry (not wall-clock):

```text
canonical_tip_epoch - commit_source_epoch > max_rewind_commits
```

Our CR-08 fall-through **drops** the candidate (`continue`). That is non-conformant on its
own terms, independent of whether the truncated-branch symptom is reachable in practice.
Note the interaction with `maxRewindCommits: Infinity` (a supported configuration): nothing
ever expires, which is also the shape of WR-02.

### Candidate-edge validity is all-or-nothing

> A commit creates a candidate edge only when it validates against a candidate parent state.
> Validation here is full commit validity: MLS validation; authorization of the authenticated
> committer against that parent state; and Marmot component validation of the resulting
> state [...] A candidate edge whose resulting state fails Marmot component invariants MUST
> NOT be created, so convergence can never select that invalid transition.

And authorization is **parent-relative**:

> the client first identifies the candidate parent through MLS authentication, then evaluates
> the committer against that state's policy. Failure against a retained state whose MLS
> authentication does not match is not an authorization failure and cannot reject the Commit.

This is the precise contract CR-11 needs the two seams to agree on.

### Safety vs liveness, split

Safety is unconditional: clients from the same retained anchor, same policy, same frozen
authenticated input batch MUST select the same branch and assign the same dispositions —
"transport arrival order, local scheduling, and device speed do not weaken this requirement."
Liveness is conditional on relevant input closing, and explicitly does not apply under
permanent delivery suppression, unbounded valid input, loss beyond retained-history limits,
incompatible policies, or resource exhaustion.

`Settled` is defined as a **local** fixed point — "not global finality."

### New, and not implemented here

- `max_convergence_pass_ms: 5000` — a new convergence-policy v1 field bounding one
  input-collection window; measured on the local monotonic clock and MUST NOT be extended by
  later input. Check `DEFAULT_CONVERGENCE_POLICY` against the updated table.
- **Anti-starvation rule**: after a bounded pass settles in `Stable`, the client MUST give one
  already-queued, admin-authorized local group-state intent one preparation attempt against
  the selected canonical state before opening another pass solely because more inbound input
  is queued.
- **Scheduler gating**: while `PendingPublish` or `Merging`, inbound input is retained but MUST
  NOT be admitted into a new pass.
- **Terminal disbanding**: `marmot.group.lifecycle.v1` -> `disbanded` forces `Stable ->
  Recovering` even for a linear edge (`refs/marmot/app-components/group-lifecycle-v1.md`,
  new). Not implemented at all.
- **Retained cryptographic material** table (`protocol-core/retained-history.md`) — per-function
  retention and release conditions. Notes that the public ratchet tree + GroupContext + commit
  bytes are *not* sufficient, because member handshake messages are MLS `PublicMessage` values
  whose membership tags need the source epoch's `membership_key`.

## 3. New spec: conformance state equivalence

`refs/marmot/foundation/conformance.md` is new and defines the projection for comparing two
clients — a ready-made oracle for the Phase 5 "byte-exact MDK cross-checks" criterion.

A conformance snapshot contains: raw MLS group id; MLS epoch; `SHA256` of the TLS-serialized
`GroupContext`; an exporter commitment; every nonblank leaf in leaf-index order (leaf index,
Marmot account identity, MLS signature public key, advertised capabilities); group-required
capabilities; every `app_data_dictionary` entry in ascending component-id order with exact
value bytes; canonical group lifecycle and convergence status; the convergence disposition of
every known scenario input keyed by stable synthetic name; and application-visible outputs.

Exporter commitment:

```text
MLS-Exporter("marmot", "convergence-conformance-v1", 32)
```

Explicitly **excluded**: local queue layout, transport cursors, retry counters, database row
ids, storage encoding, pruned secrets, private ratchet state.

This is a conformance-test interface only — it defines no wire message or interoperable
serialization.

## 4. MDK ships portable conformance vectors

`refs/mdk/crates/cgka-conformance-simulator/vectors/` — 16 JSON scenario vectors plus
`manifest.v1.json`, which marks entries `status: portable` with notes like "Keep as the smoke
fixture for independent implementations." They are built to be consumed by non-Rust
implementations.

Already named in Phase 4's existing criteria:
`convergence-committer-selected.v1.json`, `convergence-witness-selected.v1.json`,
`admin-policy-update.v1.json`, `group-data-update.v1.json`,
`group-data-fork-recovery.v1.json`, `concurrent-invite-fork-recovery.v1.json`.

**Not previously named, and the most valuable one right now:**

- **`restart-delivery-faults.v1.json`** — CR-08 and CR-09 were both restart-only bugs, invisible
  to our suite because no test built a persist -> reload -> converge scenario. MDK already has
  the vector.
- `publish-fail.v1.json` / `invite-publish-fail.v1.json` — publish-before-apply rollback and
  pending-publish failure. Directly exercises the `publishSelfUpdate` rollback added
  unreviewed in `cc7bbd6`.
- `delayed-past-epoch-app-message.v1.json`, `partition-clear-leave.v1.json`,
  `queue-faults.v1.json`, `drop-queued.v1.json`, `three-client-message-exchange.v1.json`.

The surrounding crate (`cgka-conformance-simulator`) is an in-process multi-client simulator
whose `ConvergenceSubject` is documented as "a capability-declared semantic boundary between
scenario execution and the implementation under test" — i.e. the seam an independent
implementation plugs into. `ScenarioSpec` is "the canonical JSON v2 input contract."

## 5. Smaller deltas worth a look during Phase 4

- `app-components/account-identity-proof-v2.md` is **new** and proof v2 moved from
  `foundation/` to `app-components/`. Phase 1 shipped proof v2 — re-check our implementation
  against the relocated, expanded doc.
- `app-components/group-encrypted-media-v2.md` and `features/encrypted-media-v1.md` — new.
- `app-components/multi-device-join-authorization-v1.md` — new (still out of milestone scope).
- `foundation/authorization-proofs.md` — new; `foundation/host-safety.md` deleted.
- `foundation/registries.md` (+135), `transports/nostr.md` (+183),
  `protocol-core/member-departure.md` (+113), `protocol-core/group-state.md` (+115).
- `mip-coverage.md` is the authoritative old->new mapping for the deprecated MIP numbering.
  Phase 3's WR-24 catalogues 21 stale `MIP-NN` citations in phase-3-touched files; there are
  49 in `src/` and 73 across `docs/` + `.planning/` in total.
