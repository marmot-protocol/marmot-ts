# Phase 7: Account Identity Proof Component (0x8009) + Legacy Clean Cut - Pattern Map

**Mapped:** 2026-09-14
**Files analyzed:** 21 (new/modified core, engine, client, test, doc, tooling files)
**Analogs found:** 21 / 21 (project is small and self-similar; every file has a strong same-repo analog because this phase is explicitly "build the sibling of an existing thing, then delete the old thing")

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/core/components/account-identity-proof.ts` (new) | service/utility (pure codec+validator) | transform | `src/core/authorization-proof.ts` (envelope primitive it wraps) + `src/core/account-identity-proof.ts` (legacy module being replaced, same responsibility) | exact |
| `src/core/components/ids.ts` (modify: add `0x8009` id/name) | config/constants | transform | itself, existing rows | exact |
| `src/core/components/dictionary.ts` (modify: `makeLeafAppComponentsExtension` evolves; `makeAppComponentsExtension` gains 0x8009 guard) | utility | transform | itself (SafeAAD guard at lines 127-131 is the literal template for the new guard) | exact |
| `src/core/components/index.ts` (modify: barrel export) | config | — | itself | exact |
| `src/core/key-package.ts` (modify: `generateKeyPackage` required signer, D-15 dictionary wiring) | service | CRUD (leaf/KeyPackage construction) | itself (before/after is the same file); `account-identity-proof.ts` (legacy) for the accountProofSigner threading being removed | exact |
| `src/core/capabilities.ts` (modify: drop `0xf2f1` from required-capabilities) | utility | transform | itself | exact |
| `src/core/group.ts` (modify: `DEFAULT_GROUP_COMPONENT_IDS` += `0x8009`) | config | — | `src/core/components/ids.ts` (`DEFAULT_GROUP_COMPONENT_IDS` definition site) | exact |
| `src/engine/admin-policy.ts` (modify: like-for-like `0xf2f1`→`0x8009` swap) | middleware (commit-admission gate) | event-driven | itself | exact |
| `src/client/marmot-client.ts` (modify: remove `accountProofSigner`) | provider/facade | request-response | itself | exact |
| `src/client/groups-manager.ts` (modify: remove option; add whole-tree validator + D-07 profile check at join) | service | event-driven (join via Welcome) | itself (`joinFromWelcome` at ~line 724) | exact |
| `src/client/group-factory.ts` (modify: remove `accountProofSigner`) | service | CRUD | itself | exact |
| `src/client/key-package-manager.ts` (modify: remove option; D-09 skip-legacy in `ensurePublished`/flag in `list()`) | service | CRUD | itself | exact |
| `src/client/key-package-publisher.ts` (modify: remove `accountProofSigner`) | service | request-response | itself | exact |
| `src/client/group/proposals/invite-user.ts` (modify: validate invitee KeyPackage with its own ciphersuite) | service | request-response | itself | exact |
| `src/core/__tests__/account-identity-proof.test.ts` (delete legacy, replace with test for new module — likely renamed to match `src/core/components/account-identity-proof.ts`) | test | — | `src/core/__tests__/authorization-proof.test.ts` (Phase 6 sibling test, same envelope-under-test shape) | exact |
| `src/core/__tests__/capabilities.test.ts`, `key-package.test.ts` (modify: assert `0x8009` not `0xf2f1`) | test | — | themselves | exact |
| `src/core/__tests__/darkmatter-invite-compat.test.ts` (modify: update 3 non-legacy-proof assertions in place) | test | — | itself | exact |
| `src/__tests__/conformance/proof-v2-parity.test.ts` (delete) | test | — | n/a (obsolete legacy-parity fixture consumer) | n/a — delete |
| `src/__tests__/exports.test.ts` (modify: snapshot update) | test | — | itself | exact |
| `src/__tests__/helpers/account-proof.ts`, `examples/opentui/src/helpers/account-proof.ts` (delete) | test-helper | — | n/a | n/a — delete |
| `.changeset/*.md` (new major changeset) | config | — | any existing `.changeset/*.md` entry | role-match |

## Pattern Assignments

### `src/core/components/account-identity-proof.ts` (new module, this phase's core deliverable)

**Analog 1 (primitive it wraps):** `src/core/authorization-proof.ts`
**Analog 2 (structure/shape to replace, do NOT reuse names):** `src/core/account-identity-proof.ts` (legacy, full file — to be deleted)

**Imports pattern** (from `src/core/authorization-proof.ts` lines 20-30, this is what the new module should import from):
```typescript
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { LeafNode, KeyPackage } from "ts-mls";

import {
  buildAuthorizationProofEvent,
  produceAuthorizationProof,
  verifyAuthorizationProof,
  type AuthorizationProofTemplate,
  type AuthorizationProofSigner,
  AuthorizationProofError,
} from "../authorization-proof.js";
import { getComponentData, componentEntry } from "./dictionary.js";
import { ACCOUNT_IDENTITY_PROOF_COMPONENT_ID } from "./ids.js";
```

**Error class pattern** (copy this exact shape — `src/core/authorization-proof.ts` lines 49-74, mirrored by `BinaryDecodeError` in `src/core/binary.ts:27-31`):
```typescript
export type AccountIdentityProofRejectReason =
  | "missing-support"
  | "missing-data"
  | "duplicate-data"
  | "legacy-extension-present"
  | "invalid-location"
  | "identity-mismatch"
  | "ciphersuite-mismatch"
  | "signature-key-mismatch"
  | "invalid-proof"; // wraps AuthorizationProofError as `cause` per D-13

export class AccountIdentityProofError extends Error {
  constructor(
    message: string,
    readonly reason: AccountIdentityProofRejectReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AccountIdentityProofError";
  }
}
```
Note: `AuthorizationProofError` does NOT thread `ErrorOptions`/`cause` through `super()` today — check when wrapping `invalid-proof` that `cause` is set via `options` (the standard `Error` `cause` mechanism), consistent with D-13 ("wraps the underlying `AuthorizationProofError` as `cause`").

**Template-building pattern (transliterated from spec, do not modify tag order/shape):**
```typescript
// Source: refs/marmot/app-components/account-identity-proof-v2.md "Signing event"
// Verified vector: 07-RESEARCH.md "Code Examples" section (event_id b7e9a15d...af6b)
const ACCOUNT_IDENTITY_PROOF_DOMAIN = "marmot.account-identity-proof.v2";
const ACCOUNT_IDENTITY_PROOF_CONTENT =
  "Authorize this MLS leaf key for my Marmot account";

function accountIdentityProofTemplate(
  ciphersuite: number,
  mlsSignatureKey: Uint8Array,
): AuthorizationProofTemplate {
  return {
    kind: 450,
    tags: [
      ["d", ACCOUNT_IDENTITY_PROOF_DOMAIN],
      ["component", `0x${ACCOUNT_IDENTITY_PROOF_COMPONENT_ID.toString(16).padStart(4, "0")}`],
      ["ciphersuite", `0x${ciphersuite.toString(16).padStart(4, "0")}`],
      ["signature_scheme", `0x${mlsSignatureScheme(ciphersuite).toString(16).padStart(4, "0")}`],
      ["mls_signature_key", bytesToHex(mlsSignatureKey)],
    ],
    content: ACCOUNT_IDENTITY_PROOF_CONTENT,
  };
}
```

**Ciphersuite→scheme table — re-home verbatim, do not re-derive** (from `src/core/account-identity-proof.ts` lines 76-83, this is the exact table to copy into the new module as a fresh export):
```typescript
const MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE: Record<number, number> = {
  1: 0x0807, // Ed25519 — 2055
  2: 0x0403, // ecdsa_secp256r1_sha256 — 1027
  3: 0x0807, // Ed25519 — 2055 (duplicates 1)
  4: 0x0808, // Ed448 — 2056
  // ... (7 ciphersuites total — read the remaining rows directly from
  //      src/core/account-identity-proof.ts lines 76-90 before deleting the file)
};
```

**Validator entry-point shape (explicit ciphersuite parameter, never inferred — Pitfall 3):**
```typescript
export function validateLeafAccountIdentityProof(
  leaf: LeafNode,
  ciphersuite: number,
): void {
  // 1. classify presence: legacy (0xf2f1) vs current (0x8009 dict entry) — four-way match,
  //    only (none, current) passes; everything else throws with the matching reason.
  // 2. support-list check: leaf's app_components (0x0001) entry must list 0x8009 — separate
  //    failure mode from "has data entry" (Pitfall 4).
  // 3. exactly one 0x8009 dictionary entry (duplicate-data).
  // 4. decode + verifyAuthorizationProof(template, proofBytes) — wraps AuthorizationProofError
  //    as `cause` on "invalid-proof".
  // 5. field-equality bindings: proof.signerPubkey === credential identity;
  //    tag mls_signature_key === leaf.signatureKey (both exact bytes, before/after signature verify).
}
```

**Error handling pattern to follow** (`src/core/authorization-proof.ts` lines 90-104, `assertSignerPubkey`): validate structurally first, throw the most specific reason, never let a downstream decode throw an unrelated generic error.

---

### `src/core/components/dictionary.ts` (modify: `makeAppComponentsExtension` guard + `makeLeafAppComponentsExtension` evolution)

**Analog:** itself — copy the existing SafeAAD-rejection pattern verbatim for the new guard.

**Guard pattern to copy** (lines 124-133, extend this exact `if` block):
```typescript
export function makeAppComponentsExtension(
  entries: ComponentData[],
): CustomExtension {
  if (entries.some((entry) => entry.componentId === SAFE_AAD_COMPONENT_ID)) {
    throw new UsageError(
      "SafeAAD is LeafNode-only advertisement data and is not supported as group-component state",
    );
  }
  if (entries.some((entry) => entry.componentId === ACCOUNT_IDENTITY_PROOF_COMPONENT_ID)) {
    throw new UsageError(
      "account-identity-proof (0x8009) is LeafNode-only advertisement data and is not supported as group-component state",
    );
  }
  return makeAppDataDictionaryExtension(buildAppDataDictionary(entries));
}
```

**Leaf-dictionary builder to evolve** (lines 141-150 — currently takes only `supportedIds`; D-15 requires it also take the encoded proof bytes and emit exactly one `0x8009` entry alongside the existing `app_components` list entry and the SafeAAD entry, keeping the SafeAAD entry's list independently empty per Pitfall/PROOF-06 regression coverage):
```typescript
export function makeLeafAppComponentsExtension(
  proof: Uint8Array, // NEW required param — the encoded 0x8009 proof (D-15)
  supportedIds: readonly AppComponentId[] = SUPPORTED_APP_COMPONENT_IDS,
): CustomExtension {
  return makeAppDataDictionaryExtension(
    buildAppDataDictionary([
      appComponentsEntry([APP_COMPONENTS_COMPONENT_ID, ...supportedIds]),
      componentEntry(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID, proof),
      componentEntry(SAFE_AAD_COMPONENT_ID, encodeComponentsList([])), // MUST stay []
    ]),
  );
}
```

---

### `src/core/components/ids.ts` (modify: add id + name)

**Analog:** itself, existing row shape at lines 32-54.

**Pattern:**
```typescript
export const ACCOUNT_IDENTITY_PROOF_COMPONENT_ID: AppComponentId = 0x8009;
export const ACCOUNT_IDENTITY_PROOF_COMPONENT = "marmot.member.account-identity-proof.v2";
```
Add to `SUPPORTED_APP_COMPONENT_IDS` (lines 78-87) per D-15 ("`0x8009` joins `SUPPORTED_APP_COMPONENT_IDS`"). Do NOT add to `DEFAULT_GROUP_COMPONENT_IDS` (lines 61-65) directly here — that edit belongs to `src/core/group.ts` per D-05, though the constant itself lives in this file, so check whether `DEFAULT_GROUP_COMPONENT_IDS` is defined in `ids.ts` (it is, per the read above) or re-derived in `group.ts`; either way, follow the existing list-literal style exactly (one id per line, trailing comma).

---

### `src/core/key-package.ts` (modify: required signer, D-15 wiring)

**Analog:** itself — this is a targeted diff, not a new-file pattern.

**Current shape to change** (lines 24-27, 78-85 per read above):
```typescript
import {
  type AccountIdentityProofSigner,
  buildAccountIdentityProofExtension,
} from "./account-identity-proof.js";
// ...
/**
 * Optional Nostr-account signer. When provided, the generated key package
 * carries a `marmot.account-identity-proof.v1` LeafNode extension ...
 */
accountProofSigner?: AccountIdentityProofSigner;
```
Replace with a required `signer: Pick<EventSigner, "signEvent">` (Phase 6's `AuthorizationProofSigner` type, re-exported from `../authorization-proof.js`) and route it through `produceLeafAccountIdentityProof` (the new module) into `makeLeafAppComponentsExtension`'s new `proof` parameter. Also add the optional `createdAt`/clock parameter per D-03 ("Core `generateKeyPackage`... accepts an optional injected `createdAt`/clock").

---

### `src/engine/admin-policy.ts` (like-for-like swap, D-06)

**Analog:** itself, lines 44-52 (read above) — this is the exact code to swap in place, changing only the extension-type check and adding the validator call target; **keep the `if (!hasProof) continue` skip** verbatim (D-06 explicitly preserves this known gap for Phase 8).

**Current:**
```typescript
const hasProof = leaf.extensions.some(
  (e) => e.extensionType === ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
);
if (!hasProof) continue;
try {
  verifyLeafAccountIdentityProof(leaf, ciphersuiteId);
} catch {
  return "reject";
}
```
**New (like-for-like):**
```typescript
const hasProof = getComponentData(leaf.extensions, ACCOUNT_IDENTITY_PROOF_COMPONENT_ID) !== undefined;
if (!hasProof) continue; // KNOWN GAP — Phase 8 (GRP-02/GRP-04) must close this
try {
  validateLeafAccountIdentityProof(leaf, ciphersuiteId);
} catch {
  return "reject";
}
```
Note the presence check moves from `leaf.extensions.some(extensionType ===...)` (legacy custom-extension shape) to a dictionary lookup (`getComponentData`/`getAppDataDictionary`) since `0x8009` lives in the `app_data_dictionary`, not as its own LeafNode extension type — this is a structural, not purely mechanical, swap; do not literally find/replace the extension-type check.

---

### Client layer files (`marmot-client.ts`, `groups-manager.ts`, `group-factory.ts`, `key-package-manager.ts`, `key-package-publisher.ts`, `invite-user.ts`)

**Analog:** each file against itself — D-01 is parameter deletion (`accountProofSigner?`) with the client's existing `signer: EventSigner` field threaded down instead. No new pattern to learn; grep each file for `accountProofSigner` and delete the parameter, its JSDoc, and its pass-through, then confirm the existing `signer` field already reaches the call site (it does, per RESEARCH.md's architecture map — "composition-root wiring; no new crypto, just parameter plumbing").

**`groups-manager.ts` join-time validator wiring (new call, not a swap)** — analog is the shape of any existing whole-tree/ratchet-tree walk in the same file (`joinFromWelcome`, ~line 724 per RESEARCH.md): call the new whole-tree leaf validator over every member leaf plus the D-07 GroupContext profile classifier, both from `src/core/components/account-identity-proof.ts`, and let their thrown `AccountIdentityProofError` propagate (D-14: validators throw, consistent with Phase 6 D-04's throw model in `authorization-proof.ts`).

---

### Test files

**Analog for the new/replacement core test:** `src/core/__tests__/authorization-proof.test.ts` (Phase 6 sibling — same "byte-exact vector + reject-reason enumeration" test shape). Read this file directly before writing the new `account-identity-proof.test.ts` equivalent; it is the closest same-repo template for testing an `AuthorizationProofTemplate`-based module including the byte-exact vector assertion pattern PROOF-02 needs.

**Exports snapshot test** — `src/__tests__/exports.test.ts` lines 42-331 contain the inline snapshot; update in the same commit as the legacy module deletion (per Runtime State Inventory in RESEARCH.md), removing `ACCOUNT_IDENTITY_PROOF_*`, `accountIdentityProof*`, `mlsSignatureScheme`, `signAccountIdentityProof` and adding the new module's exported symbol names.

---

## Shared Patterns

### Typed Error with `reason` literal union
**Source:** `src/core/authorization-proof.ts` lines 49-74 (`AuthorizationProofError`), mirrored by `src/core/binary.ts` lines 27-31 (`BinaryDecodeError`)
**Apply to:** `AccountIdentityProofError` in the new module — same shape: `extends Error`, sets `this.name`, carries a `readonly reason` typed as a literal union, one literal per distinct validation failure (never a coarse bucket).

### Template-over-shared-primitive
**Source:** `src/core/authorization-proof.ts` (`buildAuthorizationProofEvent`, `produceAuthorizationProof`, `verifyAuthorizationProof`)
**Apply to:** the new module must call these directly, never reimplement NIP-01 hashing/BIP-340 verify/`created_at` range checks. This is the single most important shared pattern in this phase — Phase 6 was already reviewed for exactly this logic.

### Component-dictionary guard pattern (location enforcement)
**Source:** `src/core/components/dictionary.ts` lines 127-131 (`makeAppComponentsExtension` SafeAAD rejection)
**Apply to:** the new `0x8009`-in-GroupContext guard (same file, same function, same `if (...).some(...) throw new UsageError(...)` shape) and, by extension, the D-07 GroupContext profile classifier's own "0x8009 in dictionary → throw" branch.

### Explicit ciphersuite parameter (never inferred)
**Source:** RESEARCH.md Pattern 2 / Pitfall 3, modeled on `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs`
**Apply to:** every validator entry point (`validateLeafAccountIdentityProof(leaf, ciphersuite)`, tree validator, admin-policy call site, `invite-user.ts` call site) — `ciphersuite: number` is always an explicit required parameter, never derived from the leaf/KeyPackage being validated.

### Named exports, `.js` import extensions, `Uint8Array`, `#private` fields
**Source:** project-wide convention (`CLAUDE.md`); concretely demonstrated in every file read above (`src/core/authorization-proof.ts`, `src/core/components/dictionary.ts`)
**Apply to:** all new/modified files in this phase, no exceptions.

## No Analog Found

None — every file in this phase's scope is either a targeted diff to an existing file or a same-shape sibling of an existing file (the legacy module being deleted is itself the closest analog for the new module's *scope*, while `authorization-proof.ts` is the closest analog for its *implementation pattern*).

## Deferred / Out-of-Scope Reminders (for the planner, not a pattern gap)

- `src/engine/admin-policy.ts`'s `if (!hasProof) continue` skip is a **known, intentional gap** (D-06) — do not "fix" it in this phase; Phase 8 closes it (GRP-02/GRP-04).
- GroupInfo and `AppEphemeral` PROOF-06 sub-cases have no enforcement code because no code surface exists yet (RESEARCH.md "Wrong-container enforcement points") — do not add unused reason literals speculatively (Open Question 1's recommendation).
- `tools/quality-gate/proof-v2-probe/` and `src/__tests__/fixtures/proof-v2-rust.json` are dead-weight legacy-profile fixture generators; RESEARCH.md recommends deleting them in this phase (Pitfall 2) rather than deferring to Phase 11, but this is a scoping call for the planner, not a locked decision.

## Metadata

**Analog search scope:** `src/core/`, `src/core/components/`, `src/core/__tests__/`, `src/engine/`, `src/client/`, `src/client/group/proposals/`, `src/__tests__/`
**Files scanned:** `src/core/authorization-proof.ts` (full), `src/core/components/dictionary.ts` (full), `src/core/components/ids.ts` (full), `src/core/account-identity-proof.ts` (partial, lines 1-90), `src/core/key-package.ts` (partial, lines 1-90), `src/engine/admin-policy.ts` (partial, lines 30-70), `src/core/__tests__/` directory listing
**Pattern extraction date:** 2026-09-14
