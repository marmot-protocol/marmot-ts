# Encrypted media v2

Media attachments use the source MLS state's exporter, HKDF-SHA256 and
ChaCha20-Poly1305. Kind-9 messages carry an ordered `imeta` tag for each file
and a shared caption. The encrypted files live on a blob server; their upload
does not change group state.

Enable media explicitly when creating a group:

```ts
import { encryptedMediaBlossomDefault } from "@internet-privacy/marmot-ts/core";

const group = await client.groups.create("Photos", {
  relays: ["wss://relay.example.com"],
  encryptedMedia: encryptedMediaBlossomDefault([
    "https://blobs.example.com/files",
  ]),
});
```

This requires component `0x800b` for members. Plain chat groups do not need a
media policy. An admin can activate, replace or remove it atomically with
`Proposals.proposeSetEncryptedMediaPolicy(policyOrNull)`; the engine checks
admin authority and the resulting members' signed capabilities.

## Upload and send

```ts
import {
  createBlossomMediaTransport,
  prepareMediaMessage,
} from "@internet-privacy/marmot-ts/client";

const transport = createBlossomMediaTransport({ signer: group.signer });
const prepared = await prepareMediaMessage(
  group,
  [{ blob: file, metadata: { filename: "photo.jpg", type: "image/jpeg" } }],
  { transport, caption: "Our trip", maxBytes: 32 * 1024 * 1024 },
);
await client.groups.send(group.id, prepared.intent);
```

The prepared intent carries `expectedParent`, an opaque public identity of its
source MLS state. If a commit or same-epoch branch change occurs before
encryption of the message, sending throws `StaleMediaPreparationError`.
Prepare and upload again; each encryption samples a fresh nonce. Do not strip
the guard or reuse the old reference under a new state.

The injected `MediaBlobTransport` boundary supports other storage adapters.
The built-in Blossom adapter uses bounded streaming, signed BUD-02 uploads,
ordered endpoint fallback, cancellation, no redirects and no browser credentials.
It defaults to HTTPS and rejects private literal hosts. A custom
`allowDestination(url)` can grant local test endpoints or enforce an application
allowlist. Endpoint validity is independent of permission to contact it.
The HTTP implementation and deployment network govern DNS resolution.

## Receive

Fully drain each ingest generator before processing another batch. For an
accepted application message, use its `sourceParent` alongside its decoded tags:

```ts
import { deserializeApplicationData } from "@internet-privacy/marmot-ts/core";
import { downloadMessageMedia } from "@internet-privacy/marmot-ts/client";

for await (const result of group.ingest(events)) {
  if (
    result.kind !== "processed" ||
    result.result.kind !== "applicationMessage"
  )
    continue;
  const rumor = deserializeApplicationData(result.result.message);
  if (!result.sourceParent) continue; // caption remains usable
  const attachments = await downloadMessageMedia(
    group,
    rumor.tags,
    result.sourceParent,
    { transport },
  );
  // Render rumor.content plus each ready/unavailable attachment.
}
```

`downloadMediaAttachment` handles a single validated reference. The helper
tries explicit locators first, then current policy fallbacks, including after a
corrupt response. Malformed references are omitted; failed fetches or decryption
produce an unavailable attachment without losing the caption or valid siblings.

For stored history, `await group.session.mediaSourceForRumor(rumor.id)` resolves
authenticated delivery evidence while it remains retained. Missing evidence
makes media unavailable. Never read an epoch from an untrusted tag or guess
among retained keys. Low-level `group.decryptMedia(bytes, reference, sourceParent)`
selects exactly that source; omitting the argument selects only the current state.

Media uses the existing canonical rollback-state retention and persisted delivery
ledger; it adds no indefinite private-state retention. Configure durable rewind
and ingest stores for delayed media across restarts. Once the source state is
pruned, its attachments can no longer be decrypted. An optional plaintext media
store is application-owned cache storage; decryption always verifies ciphertext,
metadata and source instead of trusting a hash-only cache hit.

## Migration from v1

**Breaking in v0.8:** unversioned media types, crypto/imeta helpers, policy
accessors and `GROUP_ENCRYPTED_MEDIA_COMPONENT_ID` now mean v2. The current
component is `0x800b`; `0x8008` retains its frozen v1 meaning.

- Replace `EncryptedMediaPolicyV1` with `EncryptedMediaPolicyV2` for current
  group creation and updates. `encryptedMediaBlossomDefault` builds v2 policy.
- Use `prepareMediaMessage` for current sends. If manually preparing a file,
  retain `encryptMedia`'s `expectedParent` and pass it to
  `createApplicationMessageIntent(rumor, { expectedParent })`.
- Historical readers can use `parseHistoricalMediaImetaTag`, which dispatches
  only on one explicit version. A failed v2 parse/decrypt never retries v1.
- Explicit `MediaAttachmentV1`, `parseMediaImetaTagV1`,
  `deriveMediaEncryptionKeyV1`, `decryptMediaFileV1`,
  `getEncryptedMediaPolicyV1` and `GROUP_ENCRYPTED_MEDIA_V1_COMPONENT_ID`
  preserve old data interpretation. `encryptedMediaBlossomDefaultV1` replaces
  the old unversioned v1 builder.
- Current-profile outbound messages reject v1 references. Unsupported legacy
  groups still require recreation; changing a component label cannot migrate
  their identity-proof profile.
- Call `keyPackages.ensurePublished` at startup to publish a new signed
  media-capable package when needed. Old private bundles remain available for
  pending Welcomes; editing publication tags does not upgrade signed capability
  bytes.

Group profile images use separate cryptography and are unchanged.

The normative sources are
[encrypted media](https://github.com/marmot-protocol/marmot/blob/d181ce1c4661ca985e8fb12a48a962dbe76fec6c/features/encrypted-media.md) and
[the v2 policy component](https://github.com/marmot-protocol/marmot/blob/d181ce1c4661ca985e8fb12a48a962dbe76fec6c/app-components/group-encrypted-media-v2.md).
See [MDK compatibility](../guide/mdk-compatibility.md) for executed evidence and
the separate Android/live-relay limitations.
