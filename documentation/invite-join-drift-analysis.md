# Invite Join Failure Analysis: Ratchet Tree Consistency Drift

## Summary

During dogfooding in mixed-client environments, some invitees failed to join groups after receiving valid welcome events.

Observed user-facing error:

```text
Failed to join group with any matching key package. Last error: non-blank intermediate node must list leaf node in its unmerged_leaves
```

Root cause is most consistent with **ratchet tree consistency drift** (fork/divergence) across implementations, not invitation transport failure.

## Context

- Marmot protocol flow: key package published -> admin invites -> commit produced -> welcome delivered -> invitee joins.
- In noisy environments with mixed implementations and aggressive self-updates, state can diverge between participants.
- Divergence later surfaces at join-time as strict ratchet tree validation failure.

## Failure Surface

At `marmot-ts` level:

- `joinGroupFromWelcome()` retries matching key packages and rethrows the last error.
- The reported invariant violation is thrown inside `ts-mls` ratchet tree validation.

Interpretation:

- Join/decryption path advanced far enough to parse and validate GroupInfo/tree.
- Failure indicates structural inconsistency in the welcome ratchet tree view (especially `unmerged_leaves` coherence along direct paths).

## Why Mixed Implementations Trigger This

Likely contributing factors:

1. Aggressive self-update timing around invite/join windows.
2. Concurrent membership-changing commits from multiple admins.
3. Out-of-order or delayed ingestion causing stale base state when producing commits/welcomes.
4. Different implementation behavior around proposal bundling and commit sequencing.
5. Divergent handling of race windows after add/commit/welcome publication.

These conditions can produce a welcome that appears valid in transport terms but references a tree state that fails strict invariants on the joiner.

## Recommendations (Actionable, Future Iteration)

### 1) Add Structured Interop Error Reporting

- Introduce typed join errors (e.g., `WELCOME_TREE_INCONSISTENT`) with metadata:
  - groupId (if available)
  - epoch
  - signer index
  - candidate key package ref
  - underlying validation code/message
- Preserve strict fail behavior (no bypass of MLS validation).

### 2) Add Pre-Join / Join Diagnostics Logs

Capture for each join attempt:

- welcome id, ciphersuite, number of secrets
- attempted key package refs and whether each matched a secret slot
- exact inner error + stack for each failed attempt
- first detected invariant mismatch context if available

### 3) Add Commit-Side Guardrails

- Optional interop-safe mode:
  - serialize membership-changing commits
  - throttle self-updates near add/join windows
  - avoid parallel admin add bursts

### 4) Add Drift/Fork Detection Before New Commits

- Compare local `(groupId, epoch, treeHash)` against recent network-observed state before sending another commit.
- If divergent, block commit and require reconciliation path.

### 5) Add Welcome Quality Gates

- Before sending welcome gift-wrap:
  - run local consistency diagnostics
  - verify tree extension presence/shape expectations
- On suspicious state, fail closed and request resync/retry.

### 6) Add Quarantine Policy for Known-Bad Peers

- If repeated invalid-tree failures are associated with a client fingerprint/version, quarantine invites/commits from that source until manual recovery.

### 7) Expand Interop Stress Tests

Add deterministic tests for:

- aggressive self-update after join
- concurrent admin commits with delayed ingestion
- mixed-version/mixed-behavior clients
- repeated add/remove churn with welcomes

Goal: reproduce drift signatures before release.

## Non-Goal

Do **not** weaken MLS tree validation to “accept” inconsistent state. Robustness should come from earlier detection, better policies, and clearer recovery paths.

## Proposed Follow-Up Work Items

1. Implement typed join error taxonomy.
2. Add debug-level structured logs in join and invite commit paths.
3. Add interop-safe commit policy mode.
4. Add drift preflight checks before commit creation.
5. Add new interop race tests based on this incident.
