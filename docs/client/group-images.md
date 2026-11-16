# Group images

A group can have a profile image. It is either a plain URL avatar or an encrypted image stored on a Blossom server, with its key carried in the group's encrypted metadata. This page shows how to read, replace, and clear the encrypted image.

A missing or unreachable image never affects the group itself: messages and membership keep working.

## Configure the image service

Every read and replacement takes a `GroupImageProfile` naming the Blossom servers your app trusts. The library has no default server:

```typescript
import type { GroupImageProfile } from "@internet-privacy/marmot-ts";

const imageProfile: GroupImageProfile = {
  endpoints: ["https://images.example.com"],
};
```

Endpoints must be HTTPS origins on public hosts. By default the library uses `fetch` with credentials, referrer, caching, and redirects disabled. You can also set `contactPolicy` to approve or refuse each request, `resolveEndpoints` to choose servers per image, or a custom `transport`.

Default limits: 10 MiB per image, 60 seconds per read or upload, and at most 4 endpoints. Override them with `maxUploadBytes`, `maxDownloadBytes`, `deadlineMs`, and `maxEndpointCandidates` on the profile.

## Read the current image

`group.image.source()` returns what to render, synchronously and without network access. A URL avatar takes precedence over a Blossom image:

```typescript
const source = group.image.source();

if (source.kind === "url") {
  showAvatarUrl(source.url); // apply your own URL policy
} else if (source.kind === "blossom") {
  const result = await group.image.read(imageProfile, { signal });
  const current = group.image.source();

  if (
    result.kind === "available" &&
    current.kind === "blossom" &&
    current.snapshotIdentity === result.snapshotIdentity
  ) {
    showAvatarBytes(result.bytes, result.mediaType);
  }
}
```

The image can change while it downloads, so compare `result.snapshotIdentity` with the current source right before displaying it. Verified images are cached in memory; nothing is persisted. You own the returned bytes and any object URL you create from them.

## Replace the image

Only a group admin can replace the image. Pass the image bytes and MIME type; the library encrypts, uploads, and commits the new metadata:

```typescript
const result = await client.groups.replaceGroupImage(
  group.id,
  bytes,
  "image/png",
  imageProfile,
  { signal },
);

if (result.kind === "unavailable") {
  showError(result.reason); // nothing was committed
} else {
  // result.publications: the usual publish results for the commit
}
```

The upload completing does not mean the change is committed; check the publication results the same way as any other group commit (see [Groups](/client/groups)). Authorization and lifecycle errors (not an admin, removed from the group) reject the promise rather than returning `unavailable`.

If upload succeeds but the commit is refused, the uploaded blob stays on the server; the library does not delete it.

## Clear the image

```typescript
const result = await client.groups.clearGroupImage(group.id);
```

Clearing removes the Blossom image from the group's metadata. It leaves any URL avatar in place, does not delete the blob from the server, and needs no profile.

::: warning Upload credentials outlive membership
The image's upload key is shared with all members in the group metadata. A member who learned it keeps it after being removed or after the image is replaced or cleared.
:::

## Unavailable results

Reads and mutations return `{ kind: "unavailable", reason }` instead of throwing for these cases:

| `reason`                        | What to do                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `no-image`                      | The group has no image. An admin can set one.                                   |
| `url-selected`                  | A URL avatar takes precedence; render `source()` instead.                       |
| `endpoint-absent`               | No endpoint configured. Supply `endpoints` or `resolveEndpoints`.               |
| `missing-blob`, `transport`     | Download failed. Check the server and retry.                                    |
| `contact-denied`, `byte-limit`  | Refused by your contact policy or limits. Review the profile.                   |
| `deadline`                      | Timed out. Retry or raise `deadlineMs`.                                         |
| `invalid-response`              | The server returned an unexpected response. Check the server and retry.         |
| `hash-mismatch`, `aead-failure` | The download failed verification. Discard it and retry from a trusted server.   |
| `stale`                         | The image changed while loading. Read `source()` again and request the new one. |
| `cancelled`                     | Your signal aborted the request.                                                |
| `closed`                        | The group was unloaded. Get the current group instance and retry.               |
