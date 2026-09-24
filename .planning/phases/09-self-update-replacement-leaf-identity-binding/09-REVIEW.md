---
phase: 09-self-update-replacement-leaf-identity-binding
reviewed: 2026-09-24T13:20:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - src/core/components/account-identity-proof.ts
  - src/core/components/index.ts
  - src/core/components/integrity.ts
  - src/core/components/leaf-replacement.ts
  - src/core/components/__tests__/integrity.test.ts
  - src/core/components/__tests__/leaf-replacement.test.ts
  - src/core/components/__tests__/tree-diff.test.ts
  - src/core/components/tree-diff.ts
  - src/core/inbound.ts
  - src/engine/admin-policy.ts
  - src/engine/fork-recovery.ts
  - src/engine/group-engine.ts
  - src/engine/ingest.ts
  - src/engine/__tests__/group-engine.test.ts
  - src/engine/__tests__/standalone-update-admission.test.ts
  - src/__tests__/exports.test.ts
  - src/__tests__/helpers/account-identity-proof-fixtures.ts
findings:
  critical: 1
  warning: 4
  info: 4
  total: 9
status: issues_found
---

# Phase 9: Code Review Report

**Reviewed:** 2026-09-24T13:20:00Z
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Phase 9 adds replacement-leaf identity binding (`classifyChangedLeaf` + the
`CommitLegalityOutcome` tri-state) and a standalone-Update admission gate, and
rewires six commit-legality seams and three Update-admission points onto the
tri-state.

The *identity-binding* logic itself holds up under adversarial reading: the
changed-leaf loop checks proof validity before classification, a definite
violation always returns before a remembered `undecidable` (integrity.ts:469-566),
the same precedence is repeated at the orchestration level
(integrity.ts:852-889), and the violation `detail` strings carry only leaf
indices and reason literals. `pnpm compile` is clean and the full suite is green
(111 files / 1249 tests).

The damage is in the **tri-state plumbing**, not the classifier. The new
`undecidable` state is wired into a code path that can *never* become decidable
(`validateLegalityWithoutProposals` calls the validator with no classification
at all), and `undecidable` is mapped there to "defer". The result is a legal,
already-applied own commit being permanently deferred, which silently drops our
own canonical branch from convergence candidacy — the exact "shallower
competitor wins the rewind" failure class the surrounding CONV-04/CR-08 comments
say must not recur. This is proven empirically below, not inferred. Three
secondary seam asymmetries follow the same shape: a rule was tightened at one
seam without the sibling seam that has to tolerate it.

Note: no `<structural_findings>` block was supplied for this review; all
findings below are narrative.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: `validateLegalityWithoutProposals` can no longer return `legal` — legal own commits are deferred forever, dropping our own canonical branch

**File:** `src/engine/fork-recovery.ts:176-243` (helper), `:274-303` (known-state
short-circuit), `:590-593` + `:650-695` (branch registration);
`src/engine/group-engine.ts:3376-3406` (`#treeResolution`), `:2790-2825`
(`#settleDisbandCandidates`)

**Issue:**
`validateLegalityWithoutProposals` calls
`validateCommitAccountIdentityProofs({ parentState, resultingState })` with **no**
`classification` (fork-recovery.ts:223-226). With `input === undefined`,
`classifyChangedLeaf` returns `undecidable` for *every* changed leaf
(leaf-replacement.ts:75), and every commit changes at least one leaf (the
committer's update-path leaf, or an added leaf). Therefore this helper's only
reachable outcomes are `violation` and `undecidable` — **`legal` is
unreachable**. Both `resolveCandidateParent` call sites map `undecidable` to
`{ kind: "deferred", reason: "temporary_refusal" }` (fork-recovery.ts:300-301,
:351-352).

Proven empirically (review-only scratch test, outside the repo, at
`/tmp/claude-1000/-home-robert-Projects-marmot-ts/8c8b1670-1779-44dd-8e42-eacaec8d7ca9/scratchpad/known-state.scratch.test.ts`):
a perfectly legal, proposal-free commit replayed through the known-state
short-circuit returns

```
PRIVATE-MESSAGE KNOWN-STATE RESOLUTION: deferred   <-- proposals not rebuildable
PUBLIC-MESSAGE  KNOWN-STATE RESOLUTION: resolved   <-- proposals rebuildable
```

The deferral is *permanent*, not temporary: no future protocol bytes can produce
a proposal list for a commit whose refs the parent snapshot no longer stages, so
`reason: "temporary_refusal"` is a misnomer for this path.

Three consequences, all fail-open in the sense that matters (they discard our
own validated state rather than an attacker's):

1. **Pool-replay fork recovery loses our own branch.** In `#buildBranches.explore`
   a deferred candidate sets `branchDeferred = true` (fork-recovery.ts:590-593),
   and `if (!extended && !branchDeferred && tipMessage !== undefined)`
   (fork-recovery.ts:650) then refuses to register that node as a branch tip. Our
   own deeper chain contributes no candidate, `selectCanonicalBranch` sees only
   the competitor, and `resolveFork` returns `recovered` onto it — discarding
   committed epochs. This is the precise failure `#recordProposalStaged`'s CR-08
   comment (group-engine.ts:536-552) documents as already having been fixed once:
   "our own deeper canonical branch was dropped as a candidate entirely — handing
   the rewind to a shallower competitor."
2. **Tree-fed re-convergence aborts.** `#treeResolution` forwards `deferred`
   (group-engine.ts:3403-3405) and `#reconvergeFromTree` returns without adopting
   anything (group-engine.ts:3169).
3. **Canonical disband can silently fail.** `#settleDisbandCandidates` feeds
   admitted terminal edges through `knownCandidates` (group-engine.ts:2810-2815);
   a candidate that defers is never registered as a branch, so the terminal edge
   is dropped and the group transitions back to `Stable` un-disbanded
   (group-engine.ts:2817-2824).

**Why CI did not catch it:** `known-state-fallback-legality.test.ts` contains a
single case, and it is a *rejecting* one. No test anywhere asserts a `legal`
outcome through `validateLegalityWithoutProposals`, so a helper that lost the
ability to return `legal` at all stayed green.

**Fix:** a deferral is only correct when later bytes can change the verdict.
Here they cannot, so this path must decide. Preferred: supply the classification
that *is* recoverable from the wire even when a `ProposalRef` cannot be resolved
— `proposalsFromPublicCommit` already reads `content.sender.leafIndex`
(fork-recovery.ts:133-135) — so the committer-update-path bucket resolves and
only genuinely unattributable leaves remain:

```ts
// fork-recovery.ts — extract the committer even when proposals cannot be rebuilt
function committerOf(message: MlsFramedMessage): number | undefined {
  if (message.wireformat !== wireformats.mls_public_message) return undefined;
  const content = message.publicMessage.content;
  if (content.contentType !== contentTypes.commit) return undefined;
  if (content.sender.senderType !== senderTypes.member) return undefined;
  return Number(content.sender.leafIndex);
}

function validateLegalityWithoutProposals(
  parentState: ClientState,
  resultingState: ClientState,
  committerLeafIndex: number | undefined, // NEW: threaded from resolveCandidateParent
): CommitLegalityOutcome {
  ...
  const proofOutcome = validateCommitAccountIdentityProofs({
    parentState,
    resultingState,
    // An empty proposal list with a KNOWN committer keeps the committer's own
    // update-path leaf decidable; only leaves attributable to nobody defer.
    classification:
      committerLeafIndex === undefined
        ? undefined
        : { proposals: [], committerLeafIndex },
  });
  ...
}
```

Then either (a) accept the residual `undecidable` as `legal` on this path (its
documented pre-Phase-9 WR-03 contract: "run every legality check that does not
need those proposals"), or (b) keep it terminal — but do **not** map it to a
deferral that can never clear. Whichever is chosen, add the missing positive
control asserting `resolveCandidateParent` still returns `resolved` for a legal
recorded child (see IN-03).

## Warnings

### WR-01: staged-proposal pruning was not extended to Updates — one bad staged Update blocks every local commit for the epoch

**File:** `src/engine/group-engine.ts:3551-3561` (`withoutInadmissibleStagedProposals`),
`:1312-1315` and `:1362-1367` (callers), `:1513-1537` (`#assertStagedCommitLegal`)

**Issue:** `withoutInadmissibleStagedProposals` filters `unappliedProposals` with
`validatePreApplyProposals` only, which inspects Adds and `AppDataUpdate`s and
ignores Update proposals entirely (admin-policy.ts:178-249). Phase 9 made an
identity-changing / proof-invalid Update a *commit-blocking* condition: it is
bundled by reference by `createCommit`, survives pruning, and then trips
`#assertStagedCommitLegal` post-apply (group-engine.ts:1519-1536), throwing
`CommitLegalityError` out of **every** `send({kind:"commit"})` and
`send({kind:"selfUpdate"})` until the epoch changes — which itself requires a
commit. That is the exact deadlock the WR-05 pruning comment
(group-engine.ts:1305-1311) says the Add pruning exists to prevent ("refusing the
commit over a staged inadmissible proposal would block every local commit ... for
the rest of the epoch"). The staging premise is identical for Updates: an older
build or a rewind onto a pre-upgrade snapshot.

**Fix:**

```ts
function withoutInadmissibleStagedProposals(
  state: ClientState,
  ciphersuiteId: number,
): ClientState {
  const entries = Object.entries(state.unappliedProposals);
  const admissible = entries.filter(
    ([, staged]) =>
      !validatePreApplyProposals([staged], ciphersuiteId) &&
      !validateUpdateProposalAccountIdentityProofs(
        [staged],
        state.ratchetTree,
        ciphersuiteId,
      ),
  );
  if (admissible.length === entries.length) return state;
  return { ...state, unappliedProposals: Object.fromEntries(admissible) };
}
```

### WR-02: a structurally unattributable inbound commit is deferred forever and pins `convergenceStatus` at `Resolving`

**File:** `src/engine/ingest.ts:835-867`

**Issue:** `capturedCommit.committerLeafIndex` is `undefined` whenever the
commit's sender is not a member — ts-mls sets it from `getSenderLeafNodeIndex`,
which returns `undefined` for every non-`member` sender type
(`ts-mls/src/sender.ts:109-111`, `processMessages.ts:288-304`). For such a commit
`classifyChangedLeaf` returns `undecidable` on every attempt, so ingest yields
`deferred(unjudgeable_identity)` forever. The envelope is pooled
(group-engine.ts:1889-1908) and re-ingested; each pass that re-defers sets
`#lastPassUnresolved` (group-engine.ts:1749), which derives
`convergenceStatus = Resolving` (convergence-status.ts:78-81) and therefore holds
**all** local outbound work via `shouldQueueOutbound` /`mayReleaseOutbound`
(consumed at marmot-group.ts:941, 1040, 1060). The retry is bounded only by
source-epoch eviction. `foundation/errors.md`'s deferral rule is for inputs that
*could* become processable; classification here can never improve, so this should
fail closed as a terminal `rejected` (`authorization_failed`) the way the
Update-admission seam does for an unresolvable sender (integrity.ts:689-695).

**Fix:** treat "no committer index and no matching proposal" as terminal at the
ingest seam — e.g. have `validateCommitAccountIdentityProofs` distinguish
"classification absent" (deferrable) from "classification present but committer
unattributable" (terminal), or, at minimum, reject rather than defer when
`capturedCommit.committerLeafIndex === undefined` *and* the commit's proposal
list was captured successfully.

### WR-03: documented non-throwing contract is violated — `getAppDataDictionary` is called unguarded on two legality paths

**File:** `src/engine/fork-recovery.ts:199` and `:205`;
`src/core/components/integrity.ts:201-202` (contract claim at `:418-420`)

**Issue:** `validateCommitLegality` is documented as pure and non-throwing, with
every throw "caught and mapped to a typed violation, never left to escape"
(integrity.ts:418-420), and `validateLegalityWithoutProposals` inherits that
contract. Both call ts-mls's `getAppDataDictionary`, which throws on malformed
bytes or a duplicate component id, outside any `try`. The sibling failure mode is
handled properly — an undecodable `app_components` becomes a typed
`component-integrity` violation (integrity.ts:821-833, fork-recovery.ts:182-193)
— so the same class of attacker-influenceable malformed dictionary bytes produces
two different dispositions: a typed rejection via one decoder, and a silent
`deferred` (fork-recovery.ts:287-288, :354-356) or an abandoned re-convergence
pass (group-engine.ts:3403-3405) via the other. That is the seam-asymmetry defect
class this phase exists to close.

**Fix:** wrap both `getAppDataDictionary` calls and map a throw to
`{ reason: "component-integrity", detail: "app_data_dictionary did not decode" }`,
matching the `getAppComponents` handling directly above them.

### WR-04: the `add` bucket suppresses the identity comparison on signature bytes alone, without consulting the commit's Remove set

**File:** `src/core/components/leaf-replacement.ts:77-89`;
consumed at `src/core/components/integrity.ts:498-502`

**Issue:** a changed leaf is classified `add` — and therefore **skips** the
prior-occupant identity comparison entirely (integrity.ts:500-501) — whenever any
Add proposal in the commit carries byte-equal `leafNode.signature`, regardless of
whether the slot it now occupies was vacated. The docstring justifies this by
"a Remove+Add commit reuses a freed slot" (leaf-replacement.ts:46-52), but the
commit's Remove set is available in the same `proposals` array and is never
consulted, and `entry.parentLeaf` (added by this phase) is never checked in this
branch. For commits whose `resultingState` is computed by ts-mls this is
unreachable (an Add is placed only at a blank leaf). It is *not* unreachable for
the two paths that feed a **stored** resulting state into the same classifier:
the known-state short-circuit (fork-recovery.ts:269-302) and
`#treeResolution`'s stamped links (group-engine.ts:3376-3387), where a persisted
or corrupted snapshot that seats an Add's leaf over a still-occupied slot is
classified `add` and admitted without an identity check. Fail-open in
authorization code, in the one place the phase's own threat model says a
pre-upgrade persisted edge must not be grandfathered.

**Fix:** require the slot to have been genuinely freed before taking the `add`
bucket:

```ts
const freed =
  changed.parentLeaf === undefined ||
  input.proposals.some(
    (p) =>
      p.proposal.proposalType === defaultProposalTypes.remove &&
      "remove" in p.proposal &&
      Number(p.proposal.remove.removed) === changed.leafIndex,
  );
if (freed && bytesEqual(proposal.add.keyPackage.leafNode.signature, changed.leaf.signature))
  return { kind: "add" };
```

(An Add matching by signature into a still-occupied, un-removed slot then falls
through to `unattributable` — fail closed.)

## Info

### IN-01: inconsistent defensive coercion of leaf indices inside the classifier

**File:** `src/core/components/leaf-replacement.ts:95` vs `:103-106`

**Issue:** the Update branch coerces (`Number(item.senderLeafIndex) === changed.leafIndex`)
while the committer branch compares the raw value (`input.committerLeafIndex === changed.leafIndex`).
Safe today (`LeafIndex = Brand<number, "LeafIndex">`, `ts-mls/src/treemath.ts:13`),
but the two callers that feed this field differ — ingest passes ts-mls's branded
value unconverted (admin-policy.ts:428), fork-recovery coerces
(fork-recovery.ts:133). If that type ever widens, a committer's own update-path
leaf silently reclassifies as `unattributable`, i.e. a terminal reject of every
honest commit.

**Fix:** use `Number(input.committerLeafIndex) === changed.leafIndex`, matching
the branch above it.

### IN-02: `undecidable` is reported on the send path with a reason literal that means the opposite

**File:** `src/engine/group-engine.ts:1530-1535`

**Issue:** `#assertStagedCommitLegal` converts `undecidable` into
`proofReason: "unattributable-leaf"`, but that literal is documented
(account-identity-proof.ts:105-108, integrity.ts:406-407) as meaning "full
classification information *was* available and the leaf is attributable to
nobody" — the precise opposite of `undecidable`. Callers branching on
`proofReason` cannot distinguish the two.

**Fix:** omit `proofReason` here, or add a distinct literal (e.g.
`unclassifiable-leaf`) for the incomplete-information case.

### IN-03: no positive control covers the legality path that regressed

**File:** `src/engine/__tests__/known-state-fallback-legality.test.ts:23-84`

**Issue:** the file holds exactly one case, and it asserts a *rejection*. Nothing
asserts that a legal recorded child still resolves through the known-state
shortcut, which is why CR-01 shipped green. The same gap exists for
`#treeResolution`'s stamped-link branch.

**Fix:** add the inverse case (benign commit, proposals not rebuildable →
`resolution.kind === "resolved"`); the scratch test cited in CR-01 is a ready
template.

### IN-04: dead destructured fixtures voided in the new tests

**File:** `src/core/components/__tests__/integrity.test.ts:589, 614, 739, 1004, 1046, 1134, 1161`;
`src/engine/__tests__/standalone-update-admission.test.ts:253`

**Issue:** values are destructured only to be discarded with `void impl;` /
`void adminPubkey;` to satisfy `noUnusedLocals` — copy-paste residue from the
fixture template rather than intent. It obscures which fixture fields a test
actually depends on.

**Fix:** destructure only the fields each test uses and drop the `void`
statements.

---

_Reviewed: 2026-09-24T13:20:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
