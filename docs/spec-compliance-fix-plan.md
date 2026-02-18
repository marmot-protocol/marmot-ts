# Spec Compliance Fix Plan (MIP-00..03)

**Date:** 2026-02-18  
**Scope:** Address gaps identified in [`docs/spec-compliance-report.md`](docs/spec-compliance-report.md:1).

This document is a **plan** (what to change, where, and how to validate). It intentionally avoids repeating detailed analysis.

---

## Guiding Principles (repo-specific)

1. **ESM + NodeNext**: keep explicit `.js` extensions for internal imports (per [`AGENTS.md`](AGENTS.md:1)).
2. **Strict TS**: explicit return types for public APIs; no implicit `any`; no unused locals.
3. **Public API discipline**: if we change exported signatures/return types, add a changeset via CLI (per [`AGENTS.md`](AGENTS.md:1)).
4. **Interop-first**: prefer changes that converge on the current MIPs, even if we temporarily keep compatibility shims behind explicit options.

---

## Inventory: Primary Integration Points

### KeyPackages (MIP-00)

- Encoding and event tags: [`createKeyPackageEvent()`](src/core/key-package-event.ts:153)
- Decoding behavior: [`getKeyPackage()`](src/core/key-package-event.ts:63)
- KeyPackageRef computation: [`calculateKeyPackageRef()`](src/core/key-package.ts:43)

### Welcome / join flow (MIP-02)

- Welcome rumor creation: [`createWelcomeRumor()`](src/core/welcome.ts:27)
- Welcome decoding: [`getWelcome()`](src/core/welcome.ts:83)
- Join flow: [`MarmotClient.joinGroupFromWelcome()`](src/client/marmot-client.ts:348)

### Group messages (MIP-03)

- Commit race ordering: [`sortGroupCommits()`](src/core/group-message.ts:278)
- Admin-only commit policy: [`createAdminCommitPolicyCallback()`](src/client/group/marmot-group.ts:114)

### Marmot Group Data extension (MIP-01 v2)

- Type/version constants: [`MARMOT_GROUP_DATA_EXTENSION_TYPE`](src/core/protocol.ts:40), [`MARMOT_GROUP_DATA_VERSION`](src/core/protocol.ts:43)
- Codec: [`encodeMarmotGroupData()`](src/core/marmot-group-data.ts:110), [`decodeMarmotGroupData()`](src/core/marmot-group-data.ts:184)
- Group creation: [`createGroup()`](src/core/group.ts:26)

---

## Plan Overview (priority-ordered)

### Phase 0 — Lock in baseline tests (before behavior changes) (DONE)

Add/adjust tests so the refactors in later phases are safe and spec-driven.

Acceptance criteria:

- Tests exist that will fail if:
  - Hex decoding remains allowed for KeyPackage/Welcome events.
  - KeyPackage events are emitted without an `i` tag.
  - v2 group-data codec is not used for new groups.
  - Commit race tie-breaker does not follow `created_at`, then `id`.

Suggested locations:

- Add/extend encoding-related tests in [`src/__tests__/key-package-event.test.ts`](src/__tests__/key-package-event.test.ts:146) and a new Welcome-focused test near [`src/core/welcome.ts`](src/core/welcome.ts:1).

---

### Phase 1 — MIP-00: KeyPackage `i` tag (KeyPackageRef) on publish (DONE)

Spec requirement:

- KeyPackage events MUST include `i` tag (hex KeyPackageRef) (see [`marmot/00.md`](marmot/00.md:75)).

Implementation strategy:

- Update [`createKeyPackageEvent()`](src/core/key-package-event.ts:153) to compute `KeyPackageRef` from the public KeyPackage and include it as `tags.push(["i", <hex>])`.
- Use existing correct ref computation in [`calculateKeyPackageRef()`](src/core/key-package.ts:43).

Acceptance criteria:

- A generated kind 443 event includes an `i` tag.
- The `i` tag value matches the computed KeyPackageRef for the encoded KeyPackage.

Compatibility note:

- This is additive and should not require a public API change (no changeset needed).

---

### Phase 2 — MIP-00 / MIP-02: base64-only decoding (reject hex) (DONE)

Spec requirement:

- `encoding` MUST be `base64`; hex MUST be rejected (see [`marmot/00.md`](marmot/00.md:64), [`marmot/02.md`](marmot/02.md:68)).

Implementation strategy:

- In [`getKeyPackage()`](src/core/key-package-event.ts:63) and [`getWelcome()`](src/core/welcome.ts:83):
  - Require `getEncodingTag(event) === "base64"`.
  - Reject missing tags or `hex` tag values.

Acceptance criteria:

- Decoding a missing-tag event fails.
- Decoding an explicit `encoding=hex` event fails.

Compatibility note:

- This is intentionally breaking behavior vs legacy events; align with current MIPs.
- If we decide to keep legacy support, it must be **explicit** (e.g., separate opt-in helper) rather than default behavior.

---

### Phase 3 — MIP-01: implement Marmot Group Data extension v2 codec (DONE)

Spec requirement:

- Version 2 extension with QUIC varint length prefixes for vectors, raw admin pubkeys, relay URL vector, variable-length image fields, and `image_upload_key` (see [`marmot/01.md`](marmot/01.md:66)).

Implementation strategy (recommended):

1. Update the data model in [`MarmotGroupData`](src/core/protocol.ts:60) to match v2 fields:
   - `adminPubkeys: Uint8Array` or `Uint8Array[]` (raw 32-byte keys)
   - `relays: string[]` remains, but encoding changes
   - image fields become `Uint8Array` with allowed 0/32 or 0/12 lengths
   - add `imageUploadKey: Uint8Array` (0/32)
   - bump [`MARMOT_GROUP_DATA_VERSION`](src/core/protocol.ts:43) to `2`
2. Implement QUIC varint helpers in [`src/core/marmot-group-data.ts`](src/core/marmot-group-data.ts:1).
3. Ensure new groups use v2 by default.
4. Decoder behavior:
   - Support decoding v2.
   - Decide whether to support decoding v1 for compatibility. If yes, implement explicit v1 path.

Acceptance criteria:

- New encode/decode roundtrip test vectors for v2.
- Decoder rejects version 0.
- Decoder can either:
  - (Option A) accept v1 and v2, or
  - (Option B) accept v2 only (strict), depending on product decision.

---

### Phase 4 — MIP-01: separate MLS `group_id` from `nostr_group_id` (DONE)

Spec requirement:

- MLS `group_id` must be private and distinct from `nostr_group_id` (see [`marmot/01.md`](marmot/01.md:13)).

Current risk:

- [`createGroup()`](src/core/group.ts:26) sets MLS `groupId = marmotGroupData.nostrGroupId`.

Implementation strategy:

- Change group creation to generate a random MLS group_id independent of `nostr_group_id`.
- Keep using `nostr_group_id` from the extension for `h` tags.

Acceptance criteria:

- A group’s MLS groupContext.groupId differs from the nostr_group_id stored in the extension.

---

### Phase 5 — MIP-03: commit race ordering tie-breaker (DONE)

Spec requirement:

- Competing commits: earliest `created_at`, then lexicographically smallest `id` (see [`marmot/03.md`](marmot/03.md:117)).

Current behavior:

- [`sortGroupCommits()`](src/core/group-message.ts:278) uses `created_at`, then `pubkey`, then `id`.

Implementation strategy:

- Update sorting to: `created_at`, then `id`.

Acceptance criteria:

- Unit test covers timestamp tie and ensures id-only tie-break.

---

### Phase 6 — MIP-02: non-admin post-join self-update + 24-hour requirement (DONE)

Spec requirement:

- After Welcome join, clients SHOULD self-update immediately; MUST within 24 hours (see [`marmot/02.md`](marmot/02.md:99)).

Constraints in current code:

- Join flow has admin-only best-effort self-update in [`MarmotClient.joinGroupFromWelcome()`](src/client/marmot-client.ts:348).

Implementation strategy:

- Decide mechanism for non-admins:
  - Option A: member sends Update proposal; admin commits it.
  - Option B: allow non-admin self-update commits (requires protocol policy changes in MarmotGroup.commit and validation rules).
- (Deferred) Add state tracking to ensure a 24-hour window is enforced/observable.

Special case (last resort KeyPackages):

- Do **not** conflate the self-update requirement with KeyPackage lifecycle.
- MIP-00 requires retaining the private `init_key` for `last_resort` KeyPackages while the KeyPackage remains published (see [`marmot/00.md`](marmot/00.md:185)).
- Therefore, post-join cleanup MUST avoid deleting `init_key` material for last-resort KeyPackages until rotation/unpublish (implemented by retaining local private material when last_resort is present).

Acceptance criteria:

- End-to-end test: invitee joins, performs self-update path available to them, then can continue ingesting commits and sending application messages.

---

## Changeset / Versioning Notes

- Adding/changing exported types (e.g., `MarmotGroupData`) is a user-facing API change and likely requires a changeset (per [`AGENTS.md`](AGENTS.md:1)).
- Behavior changes (rejecting hex) are user-facing; likely requires a changeset.
