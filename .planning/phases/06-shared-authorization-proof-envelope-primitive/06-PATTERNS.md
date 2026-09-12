# Phase 6: Shared Authorization-Proof Envelope Primitive - Pattern Map

**Mapped:** 2026-09-12
**Files analyzed:** 3 (1 new source file, 1 new test file, 2 modified files)
**Analogs found:** 4 / 4

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/core/authorization-proof.ts` | utility (pure codec + crypto primitive) | transform (encode/decode/sign/verify) | `src/core/account-identity-proof.ts` | exact (same shape: envelope encode/decode + external-signer produce/verify, same file peers `src/core/binary.ts`) |
| `src/core/__tests__/authorization-proof.test.ts` | test | transform (byte-exact vector + negative cases) | `src/core/__tests__/account-identity-proof.test.ts` | exact (same "hand-rolled signEvent + byte-exact vector" pattern) |
| `src/core/index.ts` (modify — add barrel export) | config (barrel) | — | itself, one-line pattern already present for `account-identity-proof.js` | exact |
| `src/__tests__/exports.test.ts` (modify — update snapshot) | test | — | itself (inline snapshot already lists `ACCOUNT_IDENTITY_PROOF_*` symbols) | exact |

## Pattern Assignments

### `src/core/authorization-proof.ts` (utility, transform)

**Analog:** `src/core/account-identity-proof.ts` (416 lines) + `src/core/binary.ts` (420 lines)

**Imports pattern** (`src/core/account-identity-proof.ts` lines 1-18):
```typescript
/** @module @category Core - Account Identity Proof */
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  getEventHash,
  type UnsignedEvent,
} from "applesauce-core/helpers/event";
import {
  type ClientState,
  type CustomExtension,
  defaultCredentialTypes,
  getGroupMembers,
  makeCustomExtension,
  type LeafNode,
} from "ts-mls";

import { BinaryReader, BinaryWriter } from "./binary.js";
import { getCredentialPubkey } from "./credential.js";
```
For Phase 6, the new file needs a strict subset: `schnorr`, `bytesToHex`/`hexToBytes`, `getEventHash`, `type UnsignedEvent` (or a local minimal template type per D-01/D-02 — no `ts-mls` import needed at all, since this primitive is proof-class-agnostic and has no LeafNode/CustomExtension coupling).

**Typed-error pattern to mirror** (`src/core/binary.ts` lines 26-32):
```typescript
/** Error thrown when bytes do not conform to the Marmot binary profile. */
export class BinaryDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryDecodeError";
  }
}
```
Mirror this exactly for `AuthorizationProofError`, adding a `reason` literal-union field per D-04/D-05:
```typescript
export type AuthorizationProofRejectReason =
  | "invalid-length"
  | "invalid-signer-pubkey"
  | "created-at-out-of-range"
  | "created-at-non-integer"
  | "malformed-template"
  | "invalid-signature"
  | "returned-pubkey-mismatch"
  | "returned-created-at-mismatch"
  | "returned-kind-mismatch"
  | "returned-tags-mismatch"
  | "returned-content-mismatch"
  | "returned-id-mismatch"
  | "returned-signature-invalid";

export class AuthorizationProofError extends Error {
  constructor(
    message: string,
    readonly reason: AuthorizationProofRejectReason,
  ) {
    super(message);
    this.name = "AuthorizationProofError";
  }
}
```

**104-byte envelope encode/decode pattern** — model on `encodeAccountIdentityProof` / `decodeAccountIdentityProof` (lines 242-287) but using `BinaryWriter.uint64`/`BinaryReader.uint64()` (bigint) for `created_at` instead of `uint16` length-prefixed fields, and `reader.end()` for strict trailing-byte rejection (already used at line 276):
```typescript
// encode (analog: encodeAccountIdentityProof, account-identity-proof.ts:242-260)
export function encodeAuthorizationProof(proof: AuthorizationProof): Uint8Array {
  if (proof.signerPubkey.length !== 32)
    throw new AuthorizationProofError("signer pubkey must be exactly 32 bytes", "invalid-signer-pubkey");
  if (proof.signature.length !== 64)
    throw new AuthorizationProofError("signature must be exactly 64 bytes", "invalid-length");
  return new BinaryWriter()
    .bytes(proof.signerPubkey)
    .uint64(proof.createdAt) // BinaryWriter.uint64 accepts number|bigint (binary.ts:174-182)
    .bytes(proof.signature)
    .build();
}

// decode (analog: decodeAccountIdentityProof, account-identity-proof.ts:263-287)
export function decodeAuthorizationProof(data: Uint8Array): AuthorizationProof {
  const reader = new BinaryReader(data);
  const signerPubkey = reader.bytes(32);
  const createdAtBig = reader.uint64(); // bigint, binary.ts:298-304
  const signature = reader.bytes(64);
  reader.end(); // rejects 103/105-byte inputs (D-05), binary.ts:402-408
  // range-check createdAtBig as bigint per D-06, THEN convert to Number
  if (createdAtBig < 1n || createdAtBig > 9007199254740991n /* 2^53-1 */)
    throw new AuthorizationProofError("created_at out of range", "created-at-out-of-range");
  return { signerPubkey, createdAt: Number(createdAtBig), signature };
}
```
Note: `BinaryReader` throws its own `BinaryDecodeError` (not `AuthorizationProofError`) on truncation via `this.require()` (binary.ts:270-274) — decide whether to catch-and-rewrap as `AuthorizationProofError` with reason `"invalid-length"` for a uniform error type across the module (recommended, since D-04 wants one typed error), or let `BinaryDecodeError` propagate for that one case. `account-identity-proof.ts` does NOT rewrap `BinaryDecodeError` (it just calls `reader.uint8()`/`reader.bytes()` directly and lets it throw), so precedent favors letting it propagate — but D-04's "rejections are thrown as a typed error" suggests wrapping. Flag this as a planner decision.

**External-signer produce/verify pattern** — model on `buildAccountIdentityProofExtension` (lines 309-331) and `accountIdentityProofSignatureFromSignedEvent` (lines 221-240), but strengthened per D-10 to compare every field, not just pubkey+id+sig:
```typescript
// analog: accountIdentityProofSignatureFromSignedEvent, account-identity-proof.ts:221-240
// Strengthened per D-10: compare pubkey, created_at, kind, tags, content, then id, then sig.
export async function produceAuthorizationProof(
  template: AuthorizationProofTemplate,
  signerPubkey: Uint8Array,
  createdAt: number,
  signer: Pick<EventSigner, "signEvent">, // from "applesauce-core"
): Promise<AuthorizationProof> {
  if (!Number.isSafeInteger(createdAt) || createdAt < 1)
    throw new AuthorizationProofError("createdAt must be a safe positive integer", "created-at-non-integer");

  const unsigned: UnsignedEvent = {
    pubkey: bytesToHex(signerPubkey),
    created_at: createdAt,
    kind: template.kind,
    content: template.content,
    tags: template.tags,
  };
  const signed = await signer.signEvent(unsigned);

  if (signed.pubkey.toLowerCase() !== unsigned.pubkey)
    throw new AuthorizationProofError("returned event pubkey mismatch", "returned-pubkey-mismatch");
  if (signed.created_at !== unsigned.created_at)
    throw new AuthorizationProofError("returned event created_at mismatch", "returned-created-at-mismatch");
  if (signed.kind !== unsigned.kind)
    throw new AuthorizationProofError("returned event kind mismatch", "returned-kind-mismatch");
  if (JSON.stringify(signed.tags) !== JSON.stringify(unsigned.tags))
    throw new AuthorizationProofError("returned event tags mismatch", "returned-tags-mismatch");
  if (signed.content !== unsigned.content)
    throw new AuthorizationProofError("returned event content mismatch", "returned-content-mismatch");

  const expectedId = getEventHash(unsigned); // applesauce-core/helpers/event, same as account-identity-proof.ts:194
  if (signed.id.toLowerCase() !== expectedId)
    throw new AuthorizationProofError("returned event id mismatch", "returned-id-mismatch");

  const signature = hexToBytes(signed.sig);
  if (!schnorr.verify(signature, hexToBytes(expectedId), signerPubkey))
    throw new AuthorizationProofError("returned event signature invalid", "returned-signature-invalid");

  return { signerPubkey, createdAt, signature };
}
```

**Verify path** — model on the schnorr.verify call inside `verifyLeafAccountIdentityProof` (lines 372-374), plus x-only pubkey validity check via `schnorr.utils.lift_x` per Claude's Discretion note in D-05/decisions:
```typescript
// analog: verifyLeafAccountIdentityProof's final check, account-identity-proof.ts:372-374
export function verifyAuthorizationProof(
  template: AuthorizationProofTemplate,
  proof: AuthorizationProof,
): void {
  // x-only validity distinct from signature verify (D-05, Claude's Discretion)
  try {
    schnorr.utils.lift_x(bytesToBigIntBE(proof.signerPubkey));
  } catch {
    throw new AuthorizationProofError("signer pubkey is not a valid x-only point", "invalid-signer-pubkey");
  }

  const event: UnsignedEvent = {
    pubkey: bytesToHex(proof.signerPubkey),
    created_at: proof.createdAt,
    kind: template.kind,
    content: template.content,
    tags: template.tags,
  };
  const id = getEventHash(event);
  if (!schnorr.verify(proof.signature, hexToBytes(id), proof.signerPubkey))
    throw new AuthorizationProofError("signature does not verify", "invalid-signature");
}
```

**Minimal structural template sanity checks** (D-02) — no direct analog exists; write inline:
```typescript
function assertValidTemplate(template: AuthorizationProofTemplate): void {
  if (!Number.isInteger(template.kind))
    throw new AuthorizationProofError("template kind must be an integer", "malformed-template");
  if (!Array.isArray(template.tags) || !template.tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === "string")))
    throw new AuthorizationProofError("template tags must be string[][]", "malformed-template");
  if (typeof template.content !== "string")
    throw new AuthorizationProofError("template content must be a string", "malformed-template");
}
```

**Defensive-throw awareness** (`src/client/verify.ts` lines 46-55) — `safeVerifyEvent` wraps `applesauce`'s `verifyEvent`/`getEventHash` calls in try/catch since malformed input can throw rather than return `false`. The new primitive's own id/sig checks (built directly on `schnorr.verify` + `getEventHash`, not on `applesauce`'s `verifyEvent`) don't need this wrapper themselves, but note it as the precedent for "don't assume non-throwing helpers" cited in CONTEXT.md.

---

### `src/core/__tests__/authorization-proof.test.ts` (test, transform)

**Analog:** `src/core/__tests__/account-identity-proof.test.ts` (lines 1-41 shown)

**Structure to copy**:
```typescript
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import {
  AuthorizationProofError,
  decodeAuthorizationProof,
  encodeAuthorizationProof,
  produceAuthorizationProof,
  verifyAuthorizationProof,
} from "../authorization-proof.js";

const secretKey = new Uint8Array(32); secretKey[31] = 3; // spec vector: secret key 3
const zeroAux = new Uint8Array(32); // spec vector: all-zero aux randomness

// D-13: hand-rolled signEvent reproduces the vector via schnorr.sign(id, sk, zeroAux)
const signer = {
  signEvent: async (event) => {
    const id = /* getEventHash(event) */;
    const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey, zeroAux));
    return { ...event, id, pubkey: bytesToHex(schnorr.getPublicKey(secretKey)), sig };
  },
};

describe("authorization proof — spec signing vector", () => {
  it("reproduces the exact event id, signature, and 104-byte hex", () => {
    // assert against b7e9a15d…af6b and the 104-byte component hex
  });
});

describe("authorization proof — negative cases (one per D-05 reason)", () => {
  it.each([...])("rejects %s", async () => { /* expect(...).toThrow(AuthorizationProofError) with .reason check */ });
});
```
Follow `request()`-style local fixture builders (account-identity-proof.test.ts lines 34-41) for building templates per test.

---

### `src/core/index.ts` (config, barrel export)

**Analog:** itself — the file is a flat alphabetical `export * from "./X.js"` list (current content shown below). Add `export * from "./authorization-proof.js";` in alphabetical position (after `account-identity-proof.js`, before `binary.js`):
```typescript
export * from "./account-identity-proof.js";
export * from "./authorization-proof.js";   // <-- new line, D-12
export * from "./binary.js";
export * from "./components/index.js";
...
```

---

### `src/__tests__/exports.test.ts` (test, config snapshot)

**Analog:** itself. The file asserts `Object.keys(exports).sort()` against an inline snapshot (starts at line 41) that currently begins:
```
"ACCOUNT_IDENTITY_PROOF_EVENT_KIND",
"ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE",
"ADDRESSABLE_KEY_PACKAGE_KIND",
...
```
New symbols exported from `authorization-proof.ts` (e.g. `AuthorizationProofError`, `encodeAuthorizationProof`, `decodeAuthorizationProof`, `produceAuthorizationProof`, `verifyAuthorizationProof`) must be inserted into this snapshot in sorted position, or the test will fail on a stale snapshot. Run `pnpm vitest run src/__tests__/exports.test.ts -u` to regenerate, then review the diff — do not hand-edit the snapshot. Per STATE.md the snapshot is already stale from unrelated prior work; check whether this phase's update also needs to absorb that pre-existing drift (verify by running the test before this phase's changes).

---

## Shared Patterns

### Typed decode/domain error with `reason` field
**Source:** `src/core/binary.ts` lines 26-32 (`BinaryDecodeError`), reason-field convention from `src/core/inbound.ts` (`DeferredReason`) and `src/engine/fork-recovery.ts` lines 75-76 (`{ kind: "rejected"; reason: "..." }` discriminated unions)
**Apply to:** `AuthorizationProofError` — extend `Error`, set `this.name` in constructor, add a `reason` field typed as a string literal union (not a coarse bucket, per D-05).

### Binary envelope codec via `BinaryWriter`/`BinaryReader`
**Source:** `src/core/binary.ts` (whole file) — `uint64()` (bigint big-endian, lines 173-182 write / 298-304 read), `bytes(n)` fixed-width (lines 189-192 write / 327-338 read), `reader.end()` strict trailing-byte check (lines 402-408)
**Apply to:** `encodeAuthorizationProof`/`decodeAuthorizationProof` — no varints needed since the envelope is fixed 32+8+64=104 bytes; use only `bytes()` and `uint64()`.

### External-signer full-field returned-event validation
**Source:** `src/core/account-identity-proof.ts` lines 221-240 (`accountIdentityProofSignatureFromSignedEvent`) — the prior (weaker) precedent checking only pubkey+id+sig
**Apply to:** `produceAuthorizationProof` — D-10 requires comparing every substituted field (pubkey, created_at, kind, tags, content) before recomputing and checking the id, then verifying the signature. Do not reuse the legacy narrower shape (`SignedAccountIdentityProofEvent`).

### `EventSigner` type usage
**Source:** `src/client/key-package-manager.ts:145`, `src/client/marmot-client.ts:95`, etc. — `import { EventSigner } from "applesauce-core";` used as a full parameter type elsewhere in `src/client`
**Apply to:** `produceAuthorizationProof`'s signer parameter — per D-09, type it as `Pick<EventSigner, "signEvent">` rather than importing the full `EventSigner` type, so hand-rolled minimal signers satisfy it without needing `getPublicKey`.

## No Analog Found

| File/Concern | Role | Data Flow | Reason |
|------|------|-----------|--------|
| Proof-class-agnostic template plug-in shape (D-01/D-02) | type/utility | transform | No existing code splits "envelope primitive" from "proof class" — `account-identity-proof.ts` bakes the kind-450 template directly into the file. This is new design territory; use RESEARCH.md / CONTEXT.md decisions (D-01 through D-08) directly rather than a codebase analog. |
| `createdAt` bigint-range-then-Number conversion (D-06) | utility | transform | No existing decode path converts a range-checked bigint to `number` post-hoc; closest precedent is `BinaryReader.varint()` (binary.ts lines 313-325), which throws if a varint bigint exceeds `Number.MAX_SAFE_INTEGER` before converting — same "check as bigint, then Number()" idea, but for a fixed `uint64` field, not a varint. Reuse that pattern's intent, not its code. |

## Metadata

**Analog search scope:** `src/core/`, `src/client/verify.ts`, `src/engine/` (for reason-field conventions), `src/__tests__/exports.test.ts`
**Files scanned:** `src/core/binary.ts`, `src/core/account-identity-proof.ts`, `src/core/__tests__/account-identity-proof.test.ts`, `src/core/index.ts`, `src/client/verify.ts`, `src/client/{group-registry,group-factory,invite-manager,groups-manager,key-package-publisher,key-package-manager,marmot-client}.ts` (EventSigner usage grep), `src/core/commit-authorization.ts`, `src/core/inbound.ts`, `src/engine/{ingest-disposition,disband-request,ingestion-pool,fork-recovery,ingest}.ts` (reason-field grep), `src/__tests__/exports.test.ts`
**Pattern extraction date:** 2026-09-12
