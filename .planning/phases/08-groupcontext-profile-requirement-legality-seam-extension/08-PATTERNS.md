# Phase 8: GroupContext Profile Requirement & Legality-Seam Extension - Pattern Map

**Mapped:** 2026-09-15
**Files analyzed:** 9
**Analogs found:** 9 / 9 (all modify existing files; no wholly-new source files except one optional new `src/core` module)

This phase is almost entirely *extension* of existing files, not new files. RESEARCH.md already
pinpoints exact insertion lines for every change with HIGH confidence (direct source reads); this
file translates that into the planner's pattern-assignment format and adds concrete excerpts for
the surrounding conventions (imports, error style, non-throwing adapter contract) each edit must
match.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/core/components/integrity.ts` (extend `validateCommitLegality`) | service (pure validator) | transform | itself — extend existing 3-check chain, same file | exact (self-extension) |
| `src/core/components/tree-diff.ts` (new, Claude's discretion on name) | utility (pure) | transform | `src/core/group-members.ts` (`getGroupMemberPubkeys`) | exact — same "pure `ClientState`/ratchet-tree read" role and CRUD-free transform flow |
| `src/engine/admin-policy.ts` (extend `createAdminCommitPolicyCallback`) | middleware (inbound policy gate) | event-driven | itself — extend the existing commit-embedded-Add loop's pattern onto the `"proposal"` branch | exact (self-extension) |
| `src/engine/group-engine.ts` `case "proposal"` (~:879-902) | controller (state-machine transition) | event-driven | `src/client/group/proposals/invite-user.ts` (`proposeInviteUser`) for the validation call shape; `#assertStagedCommitLegal` (:1285-1298) for the throw style | role-match |
| `src/engine/group-engine.ts` `send()` D-11 gate (~:806-819) | middleware (guard) | event-driven | same file's existing `removedFromGroup` tombstone gate (:812-819) | exact — same function, same gate style |
| `src/engine/ingest.ts` D-11 gate (~:344-371) | middleware (guard) | event-driven | same file's existing disband/`removedFromGroup` gates (:344-371) | exact — same function, same gate style |
| `src/engine/types.ts` (`RejectedIngestResult`/`SkippedIngestResult` reason unions) | model (type union) | transform | itself — add one literal to each existing union | exact |
| `src/client/group-registry.ts` (D-11 classify-on-load) | service (load pipeline) | CRUD (read) | same file's existing `status`-derivation-on-load pattern in `load`/`build`/`track` | exact |
| `src/client/group/marmot-group.ts` (D-11 exposed flag getter) | model/component (public facade) | request-response | same file's existing `status` getter (:537-542) and `#assertNotDisbanded()` (:800-802) | exact |
| `src/engine/__tests__/commit-legality-seams-account-identity-proof.test.ts` (new, GRP-02 parity matrix) | test | request-response | `src/engine/__tests__/commit-legality-seams.test.ts` (full file — the explicit model per D-04) | exact |

## Pattern Assignments

### `src/core/components/integrity.ts` (service, transform)

**Analog:** itself, lines 38-373 (full existing file read)

**Imports pattern** (lines 1-22):
```typescript
/** @module @category Core - App Components */
import {
  appDataUpdateProposalType,
  ClientState,
  getAppDataDictionary,
  GroupContextExtension,
  Proposal,
  ProposalWithSender,
} from "ts-mls";

import { getAdminPolicy, getAppComponents } from "./dictionary.js";
import { getGroupMemberPubkeys } from "../group-members.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  AppComponentId,
} from "./ids.js";
import { bytesEqual } from "./bytes.js";
import {
  classifyDisbandCommit,
  type DisbandClassification,
} from "./disband-validation.js";
```
New imports needed: `classifyGroupAccountIdentityProofProfile`, `validateLeafAccountIdentityProof`,
`AccountIdentityProofError`, `AccountIdentityProofRejectReason` from `./account-identity-proof.js`;
the new tree-diff helper from wherever it lands (D-02).

**Reason union to extend** (lines 38-39):
```typescript
export type CommitIntegrityViolationReason =
  "component-integrity" | "admin-leaf-coupling" | "disband-legality";
```
D-05: add `"account-identity-proof"` as a fourth literal.

**Violation shape to extend** (lines 49-52):
```typescript
export interface CommitIntegrityViolation {
  reason: CommitIntegrityViolationReason;
  detail: string;
}
```
D-06: add `proofReason?: AccountIdentityProofRejectReason; leafIndex?: number;` — both optional,
both pubkey-free per the diagnostics-privacy rule already enforced elsewhere in this file (`detail`
never contains pubkeys — see the `component-integrity` violation's `detail` strings as precedent).

**Core adapter pattern to extend, in order** (lines 312-373, full function):
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
  const proposals = proposalsWithSenders.map(({ proposal }) => proposal);
  const appDataUpdateOps = collectAppDataUpdateOps(proposals);

  let requiredIds: readonly AppComponentId[];
  try {
    requiredIds =
      getAppComponents(args.parentState.groupContext.extensions) ?? [];
  } catch {
    return {
      reason: "component-integrity",
      detail: "current app_components component did not decode",
    };
  }

  const integrityViolation = validateAppComponentIntegrity({
    currentExtensions: args.parentState.groupContext.extensions,
    resultingExtensions: args.resultingState.groupContext.extensions,
    appDataUpdateOps,
    requiredIds,
  });
  if (integrityViolation) return integrityViolation;

  // D-07 INSERT HERE: profile/proof check, between component-integrity and disband.

  const disband: DisbandClassification = classifyDisbandCommit({
    parentState: args.parentState,
    resultingState: args.resultingState,
    proposals: proposalsWithSenders,
    committerLeafIndex: args.committerLeafIndex,
  });
  if (disband.kind === "violation")
    return { reason: "disband-legality", detail: disband.detail };

  const resultingMemberAccounts = getGroupMemberPubkeys(args.resultingState);

  return validateAdminLeafCoupling({
    currentExtensions: args.parentState.groupContext.extensions,
    resultingExtensions: args.resultingState.groupContext.extensions,
    resultingMemberAccounts,
  });
}
```

**Error handling pattern:** non-throwing by contract. The existing `try/catch → typed violation`
wrapper around `getAppComponents` (lines 339-347) is the exact precedent for wrapping the new
`validateLeafAccountIdentityProof`/`classifyGroupAccountIdentityProofProfile` calls — both of those
throw (`AccountIdentityProofError`), and this adapter must catch and map, never let the throw
escape, because fork-recovery and tree-fed convergence call this function unwrapped.

**Docstring convention** (lines 24-35, 296-311): every check documents *why* it lives centrally
("no seam re-derives them independently — the mdk#707 bug class") — match this style for the new
check's doc comment.

---

### `src/core/components/tree-diff.ts` (new pure utility, transform)

**Analog:** `src/core/group-members.ts` (full file, lines 1-40+ read)

**Imports/style pattern:**
```typescript
/** @module @category Core - Group Members */
import {
  ClientState,
  Credential,
  defaultCredentialTypes,
  getGroupMembers as getMlsGroupMembers,
  LeafNode,
  nodeTypes,
} from "ts-mls";
import { getCredentialPubkey, isSameCredential } from "./credential.js";

function nodeToLeafIndex(nodeIndex: number): number {
  // This matches ts-mls treemath: nodeToLeafIndex(nodeIndex) = nodeIndex / 2
  // for leaf positions in the ratchet tree.
  return Math.floor(nodeIndex / 2);
}
```
Reuse this exact `nodeToLeafIndex` helper/comment — RESEARCH.md's sketch (Pattern 2) duplicates it;
prefer importing/sharing rather than re-deriving, or at minimum matching it byte-for-byte in style.

**Core pattern** — RESEARCH.md's Pattern 2 sketch is the load-bearing reference implementation
(already vetted against `ts-mls`'s exported surface, do not deviate on the `signature`-inequality
approach or re-attempt `leafNodeEqual`):
```typescript
export interface ChangedLeaf {
  leafIndex: number;
  leaf: LeafNode;
}

export function diffChangedLeaves(
  parentTree: RatchetTree,
  resultingTree: RatchetTree,
): ChangedLeaf[] {
  const changed: ChangedLeaf[] = [];
  const maxLength = Math.max(parentTree.length, resultingTree.length);
  for (let nodeIndex = 0; nodeIndex < maxLength; nodeIndex += 2) {
    const before = parentTree[nodeIndex];
    const after = resultingTree[nodeIndex];
    if (!after || after.nodeType !== nodeTypes.leaf) continue; // blank or removed: skip (D-02)
    const beforeLeaf =
      before && before.nodeType === nodeTypes.leaf ? before.leaf : undefined;
    if (beforeLeaf && bytesEqual(beforeLeaf.signature, after.leaf.signature))
      continue; // unchanged: trusted, skip (D-01)
    changed.push({ leafIndex: nodeIndex / 2, leaf: after.leaf });
  }
  return changed;
}
```
Use `bytesEqual` from `src/core/components/bytes.ts` (already handles `undefined` args, lines 12-19
of that file) — do not hand-roll comparison.

**Do not** import `leafNodeEncoder`/`leafNodeEqual`/`signLeafNodeUpdate` from `ts-mls` — confirmed
not exported at package root (`ts-mls/src/index.ts`), and the vendor guard
(`scripts/vendor-ts-mls.mjs`) fails the build on any subpath `ts-mls` specifier in production code.

---

### `src/engine/admin-policy.ts` (middleware, event-driven)

**Analog:** itself, lines 1-61 (full existing callback read)

**Imports pattern** (lines 1-16):
```typescript
/** @module @category Engine */
import {
  defaultProposalTypes,
  getCredentialFromLeafIndex,
  selfRemoveProposalType,
  type ClientState,
  type IncomingMessageCallback,
  type LeafIndex,
  type ProposalWithSender,
} from "ts-mls";

import {
  hasAccountIdentityProofMaterial,
  validateKeyPackageAccountIdentityProof,
} from "../core/components/account-identity-proof.js";
import { getCredentialPubkey } from "../core/credential.js";
```

**D-08/D-09 exact gap to close** (lines 39-61):
```typescript
return (incoming) => {
    if (incoming.kind === "proposal") return "accept";   // <-- D-09: replace with Add validation

    for (const { proposal } of incoming.proposals) {
      if (proposal.proposalType !== defaultProposalTypes.add) continue;
      if (!("add" in proposal)) continue;
      const keyPackage = proposal.add.keyPackage;
      // D-08: REMOVE this skip branch entirely — validate every Add unconditionally.
      if (
        !hasAccountIdentityProofMaterial(keyPackage) &&
        !hasAccountIdentityProofMaterial(keyPackage.leafNode)
      )
        continue;
      try {
        validateKeyPackageAccountIdentityProof(keyPackage, ciphersuiteId);
      } catch {
        return "reject";
      }
      // ... (rest of loop, unmodified)
    }
```
For D-09's `"proposal"` branch: `IncomingMessageCallback`'s `"proposal"` variant is
`{ kind: "proposal"; proposal: ProposalWithSender }` (single proposal, not an array). Apply the
same `try { validateKeyPackageAccountIdentityProof(...) } catch { return "reject"; }` body to
`incoming.proposal.proposal` when its `proposalType === defaultProposalTypes.add`; other proposal
kinds keep `"accept"`.

---

### `src/engine/group-engine.ts` `case "proposal"` (controller, event-driven)

**Analog:** `src/client/group/proposals/invite-user.ts` `proposeInviteUser` (lines 10-28) for the
validate-before-propose call shape.

```typescript
// Source pattern: src/client/group/proposals/invite-user.ts:10-28
// proposeInviteUser validates the invitee KeyPackage BEFORE returning a ProposalAction.
```
D-09 requires the same guard directly in `group-engine.ts`'s local `case "proposal"` handler
(~:879-902), since a caller can bypass `proposeInviteUser` by constructing a raw
`send({ kind: "proposal", proposal: { proposalType: defaultProposalTypes.add, ... } })`. Gate on
`intent.proposal.proposalType === defaultProposalTypes.add`, call
`validateKeyPackageAccountIdentityProof` before `createProposal`, throw (not return a violation —
this is the local/outbound throw-on-invalid seam, matching `#assertStagedCommitLegal`'s throw
style at lines 1285-1298) on failure.

**Error handling pattern to match** (lines 1285-1298 — the `CommitLegalityError` throw style):
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
Note: a raw Add smuggled via `send({kind:"commit", extraProposals:[rawAdd]})` needs NO separate
D-09 gate — `#assertStagedCommitLegal` already runs after `createCommit` in both `"commit"` and
`"selfUpdate"` cases and will catch it via the D-02 tree-diff once that lands.

---

### `src/engine/group-engine.ts` `send()` D-11 outbound gate (middleware, event-driven)

**Analog:** same file, same function's existing `removedFromGroup` gate (lines 806-819):
```typescript
async send(intent: SendIntent): Promise<SendResult<TEnvelope>> {
    await this.#disbandHydrated;
    if (this.#disbandRequest?.status === "pending") throw new DisbandingError();
    // D-14: once canonical state is the removedFromGroup tombstone, no
    // outbound intent may proceed — checked before the audit `send_entry`
    // emit and before #sendInner, mirroring the `mayPrepareLocalCommit` throw
    // style below.
    if (this.#state.groupActiveState.kind === "removedFromGroup") {
      throw new Error(
        "Cannot send: this client has been removed from the group.",
      );
    }
    const intentKind = auditSendIntentKind(intent);
    this.#emitAudit({ type: "send_entry", intent_kind: intentKind });
    try {
      const result = await this.#sendInner(intent);
      // ...
```
D-11: add the unsupported-profile check in the exact same position (before the audit `send_entry`
emit), same throw style (plain `new Error(...)` or a small typed error class matching
`DisbandingError`'s pattern), reading a profile classification computed once and cached on the
engine/group (not re-derived per call — mirror how `groupActiveState.kind` is a pre-computed field,
not a re-derivation).

---

### `src/engine/ingest.ts` D-11 inbound gate (middleware, event-driven)

**Analog:** same file, existing disband + `removedFromGroup` gates (lines 344-371):
```typescript
// D-04: canonical disband is an absorbing input gate. Keep this before even
// reading ClientState so direct engine callers cannot reopen crypto,
// convergence passes, timers, dedup, or application delivery.
if (ctx.isDisbanded?.()) {
  for (const envelope of envelopes)
    yield { kind: "skipped", envelope, reason: "group-disbanded" };
  return;
}

// D-13: once canonical state is the removedFromGroup tombstone, later input
// for this group is classified `self-evicted` before any per-message work —
// no peel, no decrypt, no authentication. This must be the very first check
// in the function, ahead of the peel call, so a whole batch short-circuits
// uniformly regardless of retry state.
if (ctx.getState().groupActiveState.kind === "removedFromGroup") {
  log(
    "group is removedFromGroup – yielding %d envelope(s) as self-evicted",
    envelopes.length,
  );
  for (const envelope of envelopes) {
    yield { kind: "skipped", envelope, reason: "self-evicted" };
  }
  return;
}
```
D-11: add a third gate in the same position (same early-return-before-peel style), yielding
`{ kind: "skipped", envelope, reason: <new unsupported-profile reason literal> }` for every
envelope in the batch when the group's classified profile is not `"current"`.

---

### `src/engine/types.ts` (model, transform)

**Analog:** itself — `RejectedIngestResult`/`SkippedIngestResult` reason unions (lines 166-207,
per RESEARCH.md citation). Add `"account-identity-proof"` to the `RejectedIngestResult.reason`
inline union (D-05) and a new literal (e.g. `"unsupported-profile"`) to `SkippedIngestResult.reason`
(D-11). No other file needs editing for reason propagation — `src/client/session/group-session.ts`'s
`SessionIngestResult` is a distributive mapped type over this exact union (confirmed, lines 67-81 of
that file), so it picks up the new literals automatically.

**Audit normalization needs no code change** (`src/engine/group-engine.ts:2229-2235`):
```typescript
if (result.kind === "rejected") {
  this.#emitAudit({
    type: "rejection",
    msg_id: msgId,
    reason: (result.reason ?? "admin-policy").replaceAll("-", "_"),
  });
}
```
`"account-identity-proof"` → `"account_identity_proof"` happens automatically via this existing
`.replaceAll("-", "_")` call.

---

### `src/client/group-registry.ts` (service, CRUD-read)

**Analog:** itself — existing `load`/`build`/`track` pipeline (lines 140-416 per RESEARCH.md).

**Critical constraint (Pitfall 1):** `loadAll()` is `Promise.all(groupIds.map(...))`
(lines 412-415) — a throw from classification inside any single group's load rejects the whole
batch. D-11's classification MUST be wrapped in try/catch and mapped to a "treat as unsupported"
outcome, never call the throwing `assertCurrentGroupAccountIdentityProofProfile` unguarded here.
Use the non-throwing `classifyGroupAccountIdentityProofProfile` directly, or catch
`assertCurrentGroupAccountIdentityProofProfile`'s throw locally per group.

---

### `src/client/group/marmot-group.ts` (model/component, request-response)

**Analog:** itself — the `status` getter and `#assertNotDisbanded()` pattern:
```typescript
// lines 800-802
#assertNotDisbanded(): void {
    if (this.session.terminalTombstone) throw new GroupTerminalError();
}
```
D-11 recommendation (per RESEARCH.md Open Question 1): expose the existing
`AccountIdentityProofProfile` type (`"current"|"legacy"|"mixed"|"neither"`, already defined in
`src/core/components/account-identity-proof.ts:130-131`) directly as a new getter's return type —
do NOT fold it into `MarmotGroupStatus` (`"active"|"removed"|"disbanded"`, line 81), which is an
orthogonal membership-state concern. Mirror the `status` getter's shape (a plain derived read, never
a throw) at lines 537-542.

---

### `src/engine/__tests__/commit-legality-seams-account-identity-proof.test.ts` (test, request-response)

**Analog:** `src/engine/__tests__/commit-legality-seams.test.ts` — the explicit D-04 model file, full
read. Reuse:
- `fourPartyEpoch1Group()` (lines 79-183) — raw `createCommit`/`joinGroup` group-construction
  helper, bypassing the engine entirely, for forging pre-gate-violating fixtures.
- `buildComponentIntegrityViolation` (lines 203-233) — the pattern for constructing an
  `AppDataUpdate` proposal that drops a required component id (fixture 1 of the D-04 matrix).
- The send/inbound/replay assertion style at lines 442-468 and 470-526.

Three fixtures needed (see RESEARCH.md Pattern 5 for full construction recipes):
1. Commit dropping the `0x8009` requirement — `AppDataUpdate` on `APP_COMPONENTS_COMPONENT_ID`
   (`0x0001`), same shape as `buildComponentIntegrityViolation`.
2. Add whose leaf has no/invalid proof — `generateKeyPackageWithKey` (ts-mls `@public` export)
   with tampered/omitted `leafNodeExtensions`, bypassing `src/core/key-package.ts`'s
   `generateKeyPackage` (which always calls `produceAccountIdentityProof`).
3. Update-path leaf with invalid proof — two-step forge-then-self-update construction (cannot be
   built through a normal `createCommit` call; see RESEARCH.md Pitfall 2).

For the tree-fed convergence row, use `GroupHistoryTree.recordEdge()` (public method,
`src/engine/history-tree.ts:455`) to inject a pre-gate "grandfathered" edge directly, then call
`engine.reconvergeFromHistory()` and assert the switch is abandoned — do not rely on the normal
explore path to populate the tree for this row (Pitfall 3).

## Shared Patterns

### Non-throwing pure-validator contract
**Source:** `src/core/components/integrity.ts:339-347` (existing try/catch → typed-violation wrap)
**Apply to:** the new profile/proof check inside `validateCommitLegality`, and any place that calls
`validateLeafAccountIdentityProof`/`classifyGroupAccountIdentityProofProfile` from a seam that does
not itself wrap in try/catch (fork-recovery, tree-fed convergence).
```typescript
try {
  requiredIds = getAppComponents(args.parentState.groupContext.extensions) ?? [];
} catch {
  return { reason: "component-integrity", detail: "current app_components component did not decode" };
}
```

### Single-choke-point guard placement (not per-method repetition)
**Source:** `src/engine/group-engine.ts` `send()` (:806-819) and `src/engine/ingest.ts`
`ingestEnvelopes` (:344-371) — both already gate disband/removedFromGroup once, at the top of the
one function every outbound/inbound path funnels through.
**Apply to:** D-11's traffic refusal. Do NOT replicate `#assertNotDisbanded()`'s per-method pattern
(~8 call sites in `marmot-group.ts`) — add one gate in `send()` and one in `ingestEnvelopes`.

### Diagnostics-privacy in violation details
**Source:** `src/core/components/integrity.ts` `CommitIntegrityViolation.detail` — always a
component-id/count description, never a pubkey; `src/core/components/account-identity-proof.ts:582`
comment "never a pubkey."
**Apply to:** D-06's new `proofReason`/`leafIndex` fields (both are already pubkey-free by
construction — `leafIndex` is a tree position integer, `proofReason` is a reject-reason literal).

### Reason-literal audit normalization (automatic)
**Source:** `src/engine/group-engine.ts:2229-2235`, `.replaceAll("-", "_")`.
**Apply to:** no action needed for `"account-identity-proof"` → `account_identity_proof`; just add
the literal to the type union in `src/engine/types.ts`.

## No Analog Found

None — every file/edit in this phase's scope has either a direct self-extension analog (the file
already contains the pattern to extend) or a clear cross-file analog (tree-diff ← group-members.ts;
proposal validation ← invite-user.ts). RESEARCH.md's own line-numbered citations serve as the
ground truth for exact insertion points; this file adds the surrounding-convention excerpts the
planner needs to write matching code.

## Metadata

**Analog search scope:** `src/core/components/`, `src/engine/`, `src/client/group/`,
`src/client/group-registry.ts`, `src/engine/__tests__/`
**Files scanned:** `integrity.ts`, `account-identity-proof.ts`, `group-members.ts`,
`admin-policy.ts`, `group-engine.ts`, `ingest.ts`, `fork-recovery.ts`, `types.ts`,
`group-registry.ts`, `marmot-group.ts`, `invite-user.ts`, `commit-legality-seams.test.ts`
**Pattern extraction date:** 2026-09-15
