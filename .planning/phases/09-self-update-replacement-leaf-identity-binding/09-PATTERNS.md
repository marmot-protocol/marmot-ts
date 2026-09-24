# Phase 9: Self-Update / Replacement-Leaf Identity Binding - Pattern Map

**Mapped:** 2026-09-24
**Files analyzed:** 12 (9 source + 3 test/helper additions folded into existing suites)
**Analogs found:** 12 / 12 (all in-repo; every file this phase touches already contains the sibling pattern to extend)

**Project constraint reminder:** ESM TypeScript, `moduleResolution: NodeNext` — every new/modified relative import in
`src/` needs an emitted `.js` extension even when the source file is `.ts`. Named exports only. Binary data is
`Uint8Array`. `ts-mls` may only be imported via the bare `ts-mls` specifier (no `ts-mls/dist/...` subpaths) or the
vendor guard fails the build.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog (self) | Match Quality |
|---|---|---|---|---|
| `src/core/components/integrity.ts` (`validateCommitAccountIdentityProofs`, `validateCommitLegality`) | service (pure validator) | transform (state-diff → violation\|undefined\|deferred) | itself — `validateAddProposalAccountIdentityProofs` (:435) is the structural sibling for the new bucket-classify helper | exact |
| `src/core/components/tree-diff.ts` (`diffChangedLeaves`) | utility | transform (tree-diff) | itself, extend return shape | exact |
| `src/core/inbound.ts` (`deferredReasons`) | model/const-union | event-driven (disposition classification) | itself, add one literal | exact |
| `src/core/components/account-identity-proof.ts` (`AccountIdentityProofRejectReason`) | model/const-union | transform | itself, add one literal | exact |
| `src/engine/admin-policy.ts` (`incoming.kind === "proposal"` branch, :288-296) | middleware (pre-apply admission gate) | event-driven | itself — the `self_remove` sender-resolution block (:305-320) is the reject-on-unresolvable-sender template | exact |
| `src/engine/group-engine.ts` `case "proposal"` (:983) | controller (local send path) | request-response | itself — the existing Add-proof check three lines above (:986-993) is the direct sibling | exact |
| `src/engine/group-engine.ts` tri-state sites (:1482 `#assertStagedCommitLegal`, :2065 tree-sweep) | controller | request-response / event-driven | itself, each site's existing violation-handling | exact |
| `src/engine/fork-recovery.ts` (`validateLegalityWithoutProposals` :164, call sites :251, :301) | service | transform | itself, existing `{ kind: "deferred", reason: "temporary_refusal" }` catch blocks | exact |
| `src/engine/ingest.ts` (:824 tri-state mapping) | service (async-generator pipeline) | streaming | itself — `terminalResult` (:259-268) is the `deferred` disposition template | exact |
| `src/core/credential.ts` (`getCredentialPubkey` :48) | utility | transform | itself, plus consumer `admin-policy.ts:311-316` | exact |
| `src/core/components/__tests__/integrity.test.ts` | test | — | itself, `describe("validateCommitAccountIdentityProofs (D-01/D-02/D-03)")` block (:463+) | exact |
| `src/engine/__tests__/standalone-add-admission.test.ts` | test | — | itself — template for the sibling UPD-04 file/section | exact |

No file in this phase lacks an in-file or in-directory analog; every seam already contains the pattern its Update-side
sibling must mirror.

## Pattern Assignments

### `src/core/components/integrity.ts` — bucket-classification helper + `validateCommitAccountIdentityProofs` extension

**Analog:** `validateAddProposalAccountIdentityProofs` (same file, lines 415-461) — this is the structural template
named explicitly by CONTEXT.md D-01 for the new Update-branch sibling.

**Full excerpt (lines 415-461):**
```typescript
/**
 * Ported from `validate_standalone_proposal_account_identity_proof` (Add
 * branch; D-08/D-09): validates the `0x8009` proof of every Add proposal's
 * `KeyPackage` against `ciphersuite`, pure and non-throwing. Used pre-apply by
 * the standalone-proposal admission seams (`src/engine/admin-policy.ts`
 * inbound, `src/engine/group-engine.ts` local propose path) so a bad Add
 * never reaches the queued-proposal state in the first place — the commit-time
 * tree diff in {@link validateCommitAccountIdentityProofs} still catches it
 * after apply if either admission gate is bypassed, since both call the same
 * underlying {@link validateKeyPackageAccountIdentityProof}.
 *
 * Accepts both bare `Proposal` and `ProposalWithSender` items (normalizes
 * each first) and ignores every non-Add proposal kind. Returns on the first
 * failing Add; `leafIndex` is always omitted (the KeyPackage has no tree
 * position yet, pre-apply).
 *
 * @see refs/mdk/crates/cgka-engine/src/account_identity_proof.rs `validate_membership_proposal`
 */
export function validateAddProposalAccountIdentityProofs(
  proposals: readonly (Proposal | ProposalWithSender)[],
  ciphersuite: number,
): CommitIntegrityViolation | undefined {
  const normalized = proposals.map((item) =>
    "proposal" in item ? item.proposal : item,
  );
  for (let position = 0; position < normalized.length; position++) {
    const proposal = normalized[position]!;
    if (proposal.proposalType !== defaultProposalTypes.add) continue;
    if (!("add" in proposal)) continue;
    try {
      validateKeyPackageAccountIdentityProof(
        proposal.add.keyPackage,
        ciphersuite,
      );
    } catch (err) {
      if (err instanceof AccountIdentityProofError) {
        return {
          reason: "account-identity-proof",
          detail: `Add proposal ${position} KeyPackage account identity proof invalid (${err.reason})`,
          proofReason: err.reason,
        };
      }
      return {
        reason: "account-identity-proof",
        detail: `Add proposal ${position} KeyPackage account identity proof validation failed`,
      };
    }
  }
  return undefined;
}
```

**Core pattern to extend — `validateCommitAccountIdentityProofs`** (lines 361-410, current signature and loop body):
```typescript
export function validateCommitAccountIdentityProofs(args: {
  parentState: ClientState;
  resultingState: ClientState;
}): CommitIntegrityViolation | undefined {
  // ... profile-support checks unchanged ...
  const changedLeaves = diffChangedLeaves(
    args.parentState.ratchetTree,
    args.resultingState.ratchetTree,
  );
  for (const { leafIndex, leaf } of changedLeaves) {
    try {
      validateLeafAccountIdentityProof(
        leaf,
        args.resultingState.groupContext.cipherSuite,
      );
    } catch (err) {
      if (err instanceof AccountIdentityProofError) {
        return {
          reason: "account-identity-proof",
          detail: `member leaf ${leafIndex} account identity proof invalid (${err.reason})`,
          proofReason: err.reason,
          leafIndex,
        };
      }
      return {
        reason: "account-identity-proof",
        detail: `member leaf ${leafIndex} account identity proof validation failed`,
        leafIndex,
      };
    }
  }
  return undefined;
}
```
D-01 requires this signature to grow `proposals` and `committerLeafIndex` (both already available one call site up,
in `validateCommitLegality`, lines 526-539 below) and the loop body to classify each `{ leafIndex, leaf }` into
Add / Update-proposal / committer-update-path / unattributable before deciding whether to run an identity-equality
check against the parent leaf (use `getCredentialPubkey` + ts-mls's `getCredentialFromLeafIndex`, the same pairing
already used at `admin-policy.ts:311-316`).

**Caller / plumbing site — `validateCommitLegality`** (lines 526-539, the exact place `proposals` and
`committerLeafIndex` are already destructured but not yet forwarded):
```typescript
export function validateCommitLegality(args: {
  parentState: ClientState;
  resultingState: ClientState;
  proposals: readonly (Proposal | ProposalWithSender)[];
  committerLeafIndex?: number;
}): CommitIntegrityViolation | undefined {
  const proposalsWithSenders: ProposalWithSender[] = args.proposals.map(
    (item) =>
      "proposal" in item
        ? item
        : { proposal: item, senderLeafIndex: undefined },
  );
  // ... integrity check unchanged ...

  const accountIdentityProofViolation = validateCommitAccountIdentityProofs({
    parentState: args.parentState,
    resultingState: args.resultingState,
  });
  if (accountIdentityProofViolation) return accountIdentityProofViolation;
  // ...
}
```
D-01 requires this call to also pass `proposals: proposalsWithSenders, committerLeafIndex: args.committerLeafIndex`.

**Error handling pattern:** every `AccountIdentityProofError` catch narrows on `err instanceof AccountIdentityProofError`
and falls back to an un-narrowed `CommitIntegrityViolation` on any other throw — never let a throw escape this
function (fork-recovery and tree-fed convergence call it unwrapped). D-02's "no bucket matched" fail-closed branch
should return the same violation shape, reusing `reason: "account-identity-proof"`.

---

### `src/core/components/tree-diff.ts` — `diffChangedLeaves` must surface the parent leaf

**Analog:** itself, lines 52-69 (the full function — it is short enough to extend in place).

```typescript
export function diffChangedLeaves(
  parentTree: ClientState["ratchetTree"],
  resultingTree: ClientState["ratchetTree"],
): ChangedLeaf[] {
  const changed: ChangedLeaf[] = [];
  const maxLength = Math.max(parentTree.length, resultingTree.length);
  for (let nodeIndex = 0; nodeIndex < maxLength; nodeIndex += 2) {
    const before = parentTree[nodeIndex];
    const after = resultingTree[nodeIndex];
    if (!after || after.nodeType !== nodeTypes.leaf) continue;
    const beforeLeaf =
      before && before.nodeType === nodeTypes.leaf ? before.leaf : undefined;
    if (beforeLeaf && bytesEqual(beforeLeaf.signature, after.leaf.signature))
      continue;
    changed.push({ leafIndex: nodeIndex / 2, leaf: after.leaf });
  }
  return changed;
}
```
`beforeLeaf` is already computed locally — D-01 only needs it added to the pushed object (extend the `ChangedLeaf`
interface, currently `{ leafIndex: number; leaf: LeafNode }` at lines 10-13, with an optional `parentLeaf?: LeafNode`).
Note the doc comment's warning (lines 43-48): `leafIndex` is the true MLS tree leaf index, not the member-enumeration
index `validateGroupMemberAccountIdentityProofs` uses — do not conflate them in the new bucket-classification code.

---

### `src/core/inbound.ts` — new `DeferredReason` literal (D-04)

**Analog:** itself, lines 69-79 (the `deferredReasons` const object) — this is a one-line addition, not a new pattern.

```typescript
export const deferredReasons = {
  /** An MLS application message for a future candidate epoch. */
  futureEpoch: "future_epoch",
  /** A child commit whose parent branch is not yet available. */
  missingParent: "missing_parent",
  /** Input received while the group is in PendingPublish or Merging. */
  groupBusy: "group_busy",
  /** Local admission capacity is full; retry without transport redelivery. */
  capacity: "capacity",
} as const;
```
Naming convention: camelCase key, `snake_case` string value. D-04 suggests `unjudgeable_identity`; matching key would
be e.g. `unjudgeableIdentity`. `DeferredReason` (line 81-82) is derived automatically — no other edit needed here.
`disposition.deferred(reason)` (lines 108-113) already accepts the full union; no signature change required.

---

### `src/core/components/account-identity-proof.ts` — new `AccountIdentityProofRejectReason` literal (D-05)

**Analog:** itself, lines 88-111 (the reason union and its doc comment).

```typescript
export type AccountIdentityProofRejectReason =
  | "invalid-credential"
  | "legacy-extension-present"
  | "invalid-dictionary"
  | "duplicate-data"
  | "missing-support"
  | "missing-data"
  | "invalid-location"
  | "ciphersuite-mismatch"
  | "signature-key-mismatch"
  | "identity-mismatch"
  | "invalid-proof"
  | "legacy-group"
  | "mixed-profile"
  | "missing-requirement";
```
Naming convention: `kebab-case`, one literal per distinct validation failure ("one literal per spec validation
step — never a coarse bucket", per the doc comment). D-05's new literal is emitted by the bucket-classification code
in `integrity.ts`, not by this module's own `validateLeafAccountIdentityProof` — this file only needs the union
extended (e.g. `"member-identity-changed"`), not a new throw site. Do **not** reuse `identity-mismatch` (D-05
explicitly forbids it — that literal already means "proof signer ≠ leaf credential").

---

### `src/engine/admin-policy.ts` — UPD-04 inbound gate (D-09/D-10)

**Analog:** itself. Two adjacent patterns in the same function:

**1. The current no-op proposal branch to extend** (lines 287-296):
```typescript
return (incoming) => {
  if (incoming.kind === "proposal") {
    // Add proofs (D-09) and known-component AppDataUpdate payloads (CR-03)
    // are validated here. Standalone Update admission is deferred to
    // Phase 9 (D-10) -- a bad Update leaf is still caught at commit time by
    // the tree-diff adapter.
    return validatePreApplyProposals([incoming.proposal], ciphersuiteId)
      ? "reject"
      : "accept";
  }
```
`incoming.proposal` here is a ts-mls `ProposalWithSender` (`ts-mls/src/incomingMessageAction.ts:8-12`), so
`incoming.proposal.senderLeafIndex` and the closed-over `ratchetTree` param are both already in scope for the new
Update branch — no new plumbing needed, exactly as CONTEXT.md states.

**2. The reject-on-unresolvable-sender template to mirror (D-10)** — the existing `self_remove` sender-resolution
block, lines 305-320:
```typescript
for (const { proposal, senderLeafIndex } of incoming.proposals) {
  if (proposal.proposalType !== selfRemoveProposalType) continue;
  if (senderLeafIndex === undefined) return "reject";
  try {
    const leaverPubkey = getCredentialPubkey(
      getCredentialFromLeafIndex(
        ratchetTree,
        toLeafIndex(Number(senderLeafIndex)),
      ),
    );
    if (adminPubkeys.includes(leaverPubkey)) return "reject";
  } catch {
    return "reject";
  }
}
```
This is the exact "resolve sender leaf, reject on `undefined` or on any throw" shape D-10 requires for the Update
branch: `senderLeafIndex === undefined` → `"reject"`; wrap `getCredentialFromLeafIndex`/`getCredentialPubkey` in
try/catch and reject on throw too.

---

### `src/engine/group-engine.ts` — UPD-04 local gate (D-09), `case "proposal"` (lines 983-1030)

**Analog:** itself — the existing Add-proof check three lines above the point where the new Update check belongs.

```typescript
case "proposal": {
  // D-09: validates any raw Add proposal before createProposal, so a
  // hand-built ProposalAction returning an Add cannot bypass
  // proposeInviteUser's own check -- throws the same
  // AccountIdentityProofError either way.
  if (
    intent.proposal.proposalType === defaultProposalTypes.add &&
    "add" in intent.proposal
  ) {
    validateKeyPackageAccountIdentityProof(
      intent.proposal.add.keyPackage,
      this.ciphersuite.id,
    );
  }

  // CR-02: the rest of the pre-apply gate — AppDataUpdate payloads and
  // the component ids no proposal may write. ...
  const proposalViolation = validatePreApplyProposals(
    [intent.proposal],
    this.ciphersuite.id,
  );
  if (proposalViolation) throw new CommitLegalityError(proposalViolation);

  const { message, newState } = await createProposal({ /* ... */ });
  // ...
}
```
D-09's local gate is a sibling `if (intent.proposal.proposalType === defaultProposalTypes.update && "update" in
intent.proposal)` block, run before `createProposal`, throwing on an unresolvable/invalid identity exactly like the
Add branch throws `AccountIdentityProofError`. Unlike the Add branch (which has no sender to resolve — a fresh
KeyPackage), the Update branch needs the *local engine's own* leaf index as sender, which is already available via
`this.state` — check how `#assertStagedCommitLegal` resolves `committerLeafIndex` (grep `groupData`/`getMarmotGroupView`
nearby) for the idiom, or resolve the local member's own leaf directly since a local Update-proposal-intent's sender
is always the local client.

---

### `src/engine/group-engine.ts` — tri-state mapping sites (:1482, :2065)

**Analog A — throw-on-violation site**, `#assertStagedCommitLegal` (lines 1475-1487):
```typescript
#assertStagedCommitLegal(
  parentState: ClientState,
  resultingState: ClientState,
  committedProposals: readonly ProposalWithSender[],
  committerLeafIndex: number,
): void {
  const violation = validateCommitLegality({
    parentState,
    resultingState,
    proposals: committedProposals,
    committerLeafIndex,
  });
  if (violation) throw new CommitLegalityError(violation);
}
```
This is a synchronous send-path throw — a new "undecidable" tri-state result must still resolve to either throw or
proceed here (there is no deferred disposition on the local send path; CONTEXT.md's discretion note leaves this to
the planner, but note this call site currently has no third branch to route to).

**Analog B — tree-sweep site**, `group-engine.ts` around lines 2054-2076 (the commit branch of the tree-fed
resolution sweep):
```typescript
let violation: CommitIntegrityViolation | undefined;
try {
  violation = validateCommitLegality({
    parentState: state,
    resultingState: result.newState,
    proposals: captured.proposals,
    committerLeafIndex: captured.committerLeafIndex,
  });
} catch {
  // Mirrors resolveCandidateParent's `deferred`: keep it pooled.
  return undefined;
}
if (violation) {
  log(
    "sweep commit rejected at node %s reason:%s detail:%s",
    tag,
    violation.reason,
    violation.detail,
  );
  // ...
}
```
`return undefined` here is the sweep's existing "keep pooled" idiom (a `catch` on today's throwing failure modes).
A tri-state "undecidable" return would take the same `return undefined` branch without needing a `catch` — this is
the site CONTEXT.md's discretion note calls "the tree sweep returns `undefined` to keep the envelope pooled."

---

### `src/engine/fork-recovery.ts` — D-03's primary path (`validateLegalityWithoutProposals` :164, call sites :251/:301)

**Analog — the existing proposal-independent legality function itself** (lines 164-207, this is the function UPD-01
must also run inside, via `validateCommitAccountIdentityProofs`, since it already calls that function directly):
```typescript
function validateLegalityWithoutProposals(
  parentState: ClientState,
  resultingState: ClientState,
): CommitIntegrityViolation | undefined {
  // ... component integrity with backedOps neutralizing rule 3 ...
  const proof = validateCommitAccountIdentityProofs({
    parentState,
    resultingState,
  });
  if (proof) return proof;
  return validateAdminLeafCoupling({ /* ... */ });
}
```
Because this function calls `validateCommitAccountIdentityProofs` with **no** `proposals`/`committerLeafIndex`, once
that function grows those params (D-01), this call site is structurally the "classification is impossible" case
D-03 describes — it must pass empty/undefined values, and the bucket classifier inside `validateCommitAccountIdentityProofs`
must treat "no proposals available" as the signal to defer rather than fail-closed-reject on an unmatched bucket.

**Analog — existing `{ kind: "deferred", ... }` catch shape**, call site at lines 244-252 (inside
`resolveCandidateParent`, the `known.parentTag` branch):
```typescript
let violation: CommitIntegrityViolation | undefined;
try {
  violation = rebuilt
    ? validateCommitLegality({ /* full proposals */ })
    : validateLegalityWithoutProposals(parent, known.state);
} catch {
  return { kind: "deferred", reason: "temporary_refusal" };
}
if (violation)
  return { kind: "rejected", reason: "authorization_or_components", result, violation };
return { kind: "resolved", result };
```
This is the exact shape CONTEXT.md's discretion note references: `fork-recovery` returns `{ kind: "deferred", reason:
"temporary_refusal" }`. A tri-state "undecidable" `CommitIntegrityViolation`-adjacent return from
`validateCommitLegality`/`validateCommitAccountIdentityProofs` should map to this same `deferred` branch (today it's
reached only via a thrown exception; the tri-state return makes it reachable without a throw).

The second call site (lines ~296-309, the `processMessage`-driven branch of the same function) follows the identical
try/violation/return shape — read together, not separately, when implementing the tri-state mapping.

---

### `src/engine/ingest.ts` — tri-state mapping (:824)

**Analog — the existing `rejected` yield this call site already produces** (lines ~818-836):
```typescript
const violation = validateCommitLegality({
  parentState,
  resultingState: result.newState,
  proposals: capturedCommit.proposals,
  committerLeafIndex: capturedCommit.committerLeafIndex,
});
if (violation) {
  log(
    "commit envelope:%s rejected reason:%s detail:%s",
    envelopeLabel(envelope),
    violation.reason,
    violation.detail,
  );
  ctx.dedup.remember(message);
  yield {
    kind: "rejected",
    result,
    envelope,
    message,
    reason: violation.reason,
    proofReason: violation.proofReason,
    leafIndex: violation.leafIndex,
    // ...
  };
  continue;
}
```

**Analog — the existing `deferred` `IngestResult` shape**, `terminalResult` (lines 259-268):
```typescript
function terminalResult<TEnvelope>(
  envelope: TEnvelope,
  deferred: Map<TEnvelope, DeferredEntry>,
  errorList: Array<{ envelope: TEnvelope; error: unknown }>,
  decryptFailed: ReadonlySet<TEnvelope>,
): IngestResult<TEnvelope> {
  const entry = deferred.get(envelope);
  if (entry)
    return {
      kind: "deferred",
      envelope,
      message: entry.message,
      reason: entry.reason,
      sourceEpoch: Number(framedEpoch(entry.message) ?? 0n),
    };
  // ... else "unreadable" ...
}
```
A tri-state "undecidable" result at the `:824` site should `yield` a `DeferredIngestResult`-shaped object using the
new `deferredReasons.unjudgeableIdentity` literal (D-04), parallel to how `terminalResult` already builds
`{ kind: "deferred", envelope, message, reason, sourceEpoch }` from a `DeferredEntry`. This is a second, distinct
`deferred`-yielding code path from the one `terminalResult` handles (that one is for peel-time deferrals; this one is
post-`processMessage`, pre-`ctx.setState`), so match the shape, not necessarily call `terminalResult` itself.

---

### `src/core/credential.ts` — `getCredentialPubkey` (identity-equality primitive, D-01)

**Analog:** itself (lines 47-61) plus its existing paired-usage site.

```typescript
export function getCredentialPubkey(credential: Credential): string {
  if (credential.credentialType !== defaultCredentialTypes.basic)
    throw new Error(
      "Credential is not a basic credential, cannot get nostr public key",
    );
  const basicCredential = credential as CredentialBasic;
  const str = bytesToHex(basicCredential.identity);
  if (isHexKey(str) === false)
    throw new Error(/* ... */);
  return str;
}
```

**Paired-usage idiom to copy** (`admin-policy.ts:311-316`):
```typescript
const leaverPubkey = getCredentialPubkey(
  getCredentialFromLeafIndex(
    ratchetTree,
    toLeafIndex(Number(senderLeafIndex)),
  ),
);
```
UPD-01's identity-equality check is `getCredentialPubkey(newLeaf.credential) === getCredentialPubkey(parentLeaf.credential)`
(both credentials already in hand once `tree-diff.ts` surfaces `parentLeaf`) — no `getCredentialFromLeafIndex` call
needed in the bucket classifier itself since `tree-diff.ts` already walks the tree by index.

---

### Tests

**`src/core/components/__tests__/integrity.test.ts`** — analog is the existing
`describe("validateCommitAccountIdentityProofs (D-01/D-02/D-03)", ...)` block (starts at line 463). The test at
line 490-505, `"returns undefined for an honest self-update (D-03: no prior-leaf identity comparison)"`, must be
updated per D-12 — code and assertion stay (an honest self-update still returns `undefined`), only the name/rationale
comment changes since the check now runs and correctly no-ops:
```typescript
it("returns undefined for an honest self-update (D-03: no prior-leaf identity comparison)", async () => {
  const { impl, ctx, adminEpoch1 } = await twoPartyEpoch1Group();
  const selfUpdate = await createCommit({
    context: ctx,
    state: adminEpoch1,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [],
  });
  const violation = validateCommitAccountIdentityProofs({
    parentState: adminEpoch1,
    resultingState: selfUpdate.newState,
  });
  expect(violation).toBeUndefined();
});
```
New UPD-01 positive/negative tests belong in this same `describe` block, following the pattern of the adjacent Add
test (`"returns undefined for an honest Add of a core-generated KeyPackage"`, lines 464-489) — build a group,
`createCommit` with the relevant `extraProposals`, call `validateCommitAccountIdentityProofs` directly (pure,
no engine), assert on `violation`/`violation.proofReason`/`violation.leafIndex`.

**`src/engine/__tests__/standalone-add-admission.test.ts`** — the five-case skeleton to mirror for UPD-04
(`describe` at line 176, five `it` blocks at 177/231/270/313/347):

```typescript
describe("standalone Add admission (GRP-04, D-08/D-09)", () => {
  it("GRP-04: engine refuses a raw Add proposal intent with a forged KeyPackage before proposing", async () => {
    // local raw proposal intent — engine.send({ kind: "proposal", proposal: {...} })
    // .rejects.toMatchObject({ name: "AccountIdentityProofError" })
  });
  it("GRP-04: engine refuses a raw Add inside a commit before createCommit", async () => {
    // local raw commit — engine.send({ kind: "commit", extraProposals: [rawAdd] })
    // catch CommitLegalityError, assert violation.reason
  });
  it("GRP-04: inbound standalone Add with a forged proof is rejected, not queued", async () => {
    // build proposal message off-engine, peeler.wrapGroupMessage, ingestAll(engine, envelope)
    // assert results contains { kind: "rejected", reason: "account-identity-proof", proofReason: "invalid-proof" }
    // assert engine.state.unappliedProposals stays empty
  });
  it("GRP-04: inbound standalone Add with a valid KeyPackage is still staged (no false positive)", async () => {
    // same shape, but the KeyPackage is honest — assert it DOES land in unappliedProposals
  });
  it("D-05: inbound commit carrying a forged Add is labeled account-identity-proof", async () => {
    // commit-time labelling parity check
  });
});
```
Fixture helpers to reuse verbatim: `testPeeler(ciphersuite)`, `fourPartyEpoch1Group()` (copied locally per this
file's own doc comment — "not exported [from commit-legality-seams.test.ts], so copied here"), `forgeKeyPackage`
from `src/__tests__/helpers/account-identity-proof-fixtures.ts`. Per D-11, UPD-04's `it` blocks can reuse
`forgeKeyPackage({ proof: "missing" | "tampered" })` unmodified (standalone-Update sender-resolution failure and
proof-invalidity are both reachable this way); only UPD-01's *pure-validator* tests need the new credential-swap
fixture (D-11 — a signed forged Update leaf cannot be constructed because ts-mls does not export
`signLeafNodeUpdate`/`signLeafNodeCommit` from its package root).

---

## Shared Patterns

### Fail-closed / deferred disposition per seam (D-03, D-04)
**Source:** `src/engine/fork-recovery.ts:244-252` (deferred), `src/engine/group-engine.ts:2058-2062` (pooled via
`return undefined`), `src/engine/ingest.ts:259-268` (`terminalResult`'s `deferred` `IngestResult`).
**Apply to:** every one of the five `validateCommitLegality` call sites listed in CONTEXT.md's discretion note.
Each seam already has its own deferral-shaped outcome; the tri-state return from `validateCommitLegality` must be
routed to each seam's *existing* idiom, not a new one:
- `fork-recovery.ts` → `{ kind: "deferred", reason: "temporary_refusal" }`
- `group-engine.ts` tree sweep → `return undefined` (stays pooled)
- `group-engine.ts` `#assertStagedCommitLegal` (send path) → no deferred disposition exists here; the planner must
  decide whether "undecidable" is even reachable on the local send path (it may not be — `committerLeafIndex` is
  always defined locally) and document why if it treats it as unreachable.
- `ingest.ts:824` → new `yield { kind: "deferred", ... }` using the D-04 literal, parallel to `terminalResult`'s shape.

### Reason-literal naming convention
**Source:** `src/core/inbound.ts:69-79` (`snake_case` string values, camelCase keys) and
`src/core/components/account-identity-proof.ts:97-111` (`kebab-case` string literals, one literal per failure mode,
never a coarse bucket).
**Apply to:** the new `DeferredReason` literal (D-04, snake_case, e.g. `"unjudgeable_identity"`) and the new
`AccountIdentityProofRejectReason` literal (D-05, kebab-case, e.g. `"member-identity-changed"`) — these two unions
use two different casing conventions; do not cross them.

### Diagnostics privacy (D-06)
**Source:** every `detail:` string in `src/core/components/integrity.ts` (e.g. `` `member leaf ${leafIndex} account
identity proof invalid (${err.reason})` ``) — never interpolates a pubkey, only a numeric `leafIndex` and the reason
string.
**Apply to:** any new `detail` string the bucket classifier constructs — `leafIndex` is allowed, credential/pubkey
bytes are not (per `refs/marmot/foundation/errors.md` §Privacy, cited in D-06).

## No Analog Found

None — every file in scope has an in-file or same-directory sibling pattern to extend, per the table above.

## Metadata

**Analog search scope:** `src/core/components/`, `src/core/`, `src/engine/`, `src/engine/__tests__/`,
`src/core/components/__tests__/`, `src/__tests__/helpers/`, `ts-mls/src/incomingMessageAction.ts` (type-only read).
**Files scanned:** 12 source/test files fully or targeted-read; 1 vendored dependency type file.
**Pattern extraction date:** 2026-09-24
