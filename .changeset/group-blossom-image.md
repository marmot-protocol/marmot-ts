---
"@internet-privacy/marmot-ts": minor
---

Support `marmot.group.blossom.image.v1` (`0x8002`), the encrypted group image White Noise uses, and
advertise it in KeyPackages. MDK only puts a group image into a group when every founding member
advertises `0x8002`, so White Noise silently created image-less groups whenever a marmot-ts user
was invited. Adds the component codec and validation (byte-compatible with MDK, including its media
type canonicalization), `getGroupBlossomImage` / `groupBlossomImageEntry`, `image` on the group
view and on `proposeUpdateMetadata`, and `encryptGroupBlossomImage` / `decryptGroupBlossomImage`.
