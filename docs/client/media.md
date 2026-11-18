# Encrypted media

Groups can share files (photos, voice notes, documents) as encrypted attachments. Files are encrypted with keys derived from the group's MLS state, uploaded to a Blossom server, and referenced from a kind 9 message by `imeta` tags. Only group members can decrypt them.

## Enable media when creating a group

Media is opt-in per group. Pass an encrypted media policy listing the Blossom servers members should upload to:

```typescript
import { encryptedMediaBlossomDefault } from "@internet-privacy/marmot-ts";

const group = await client.groups.create("Photos", {
  relays: ["wss://relay.example.com"],
  encryptedMedia: encryptedMediaBlossomDefault(["https://blossom.example.com"]),
});
```

Every member must support encrypted media; key packages created by this library advertise it (call `client.keyPackages.ensurePublished` at startup so your published package is current). An admin can add, replace, or remove the policy on an existing group by committing `Proposals.proposeSetEncryptedMediaPolicy(policyOrNull)`; see [combining proposals](/client/groups).

## Upload and send

Create a Blossom transport once, then use `prepareMediaMessage` to encrypt and upload the files and build the message. Send the returned intent like any other message:

```typescript
import {
  createBlossomMediaTransport,
  prepareMediaMessage,
} from "@internet-privacy/marmot-ts";

const transport = createBlossomMediaTransport({ signer: client.signer });

const prepared = await prepareMediaMessage(
  group,
  [{ blob: file, metadata: { filename: "photo.jpg", type: "image/jpeg" } }],
  { transport, caption: "Our trip" },
);

await client.groups.send(group.id, prepared.intent);
```

You can attach several files to one message. Uploads default to a 32 MiB limit and a 30 second timeout per file; override with `maxBytes`, `timeoutMs`, and `signal`.

::: warning Re-prepare after a stale error
Attachments are encrypted against the group's current state. If the group changes (for example, a commit lands) between preparing and sending, `client.groups.send` throws `StaleMediaPreparationError`. Call `prepareMediaMessage` again to re-encrypt and re-upload; never reuse the old intent.
:::

The default transport only contacts HTTPS servers on public hosts. For local development, pass `allowDestination: (url) => url.hostname === "localhost"`. To use non-Blossom storage, implement the `MediaBlobTransport` interface (`upload` and `fetch`) yourself.

## Receive and download

Attachments are decrypted with the exact group state the message was sent under. For a message from [history](/client/history), look that state up with `group.session.mediaSourceForRumor`, then download every attachment with `downloadMessageMedia`:

```typescript
import { downloadMessageMedia } from "@internet-privacy/marmot-ts";

const sourceParent = await group.session.mediaSourceForRumor(rumor.id);
if (sourceParent) {
  const attachments = await downloadMessageMedia(
    group,
    rumor.tags,
    sourceParent,
    { transport },
  );

  for (const attachment of attachments) {
    if (attachment.status === "ready") {
      // attachment.attachment has filename, mediaType, dim, ...
      showFile(attachment.data, attachment.attachment.mediaType);
    } else {
      showPlaceholder(attachment.attachment); // download or decryption failed
    }
  }
}
```

When you handle results from the [`ingestResult` event](/client/messages#observe-ingest-results), a `processed` application message carries the same value as `result.sourceParent`.

One failing attachment never hides the caption or the other attachments. Always render `rumor.content` even when media is unavailable.

## Keep placeholders for malformed attachments

`downloadMessageMedia` skips `imeta` tags that don't parse. To show a placeholder in their place, use `getMediaAttachmentOutcomes`, which returns one outcome per `imeta` tag in order:

```typescript
import { getMediaAttachmentOutcomes } from "@internet-privacy/marmot-ts";

for (const outcome of getMediaAttachmentOutcomes(rumor.tags)) {
  if (outcome.kind === "rejected") {
    showBrokenAttachment(outcome.attachmentIndex, outcome.rejection.kind);
  } else {
    queueDownload(outcome.attachment);
  }
}
```

Download a single accepted attachment with `downloadMediaAttachment(group, attachment, sourceParent, { transport })`.

## When media is unavailable

- **No source state:** `mediaSourceForRumor` returns `undefined` once the group no longer retains the state the message was sent under (it has moved too many epochs past it, or the stores weren't persisted across a restart). The files can no longer be decrypted.
- **Download failed:** every listed server and the group's current default servers were tried; the blob is missing, the server refused, or the request timed out.
- **Decryption failed:** the downloaded bytes don't match the attachment's hash or keys. The library never returns unverified plaintext.
- **Rejected reference:** the `imeta` tag is malformed (`invalid_structure`, `unsupported_format`, `missing_field`, `duplicate_field`, or `malformed_field`).
- **Media disabled:** downloading and sending throw if the group has no encrypted media policy.

Decrypt files promptly and keep the plaintext in your own cache if your app needs them long term: `decryptMedia` returns the bytes and stores nothing.
