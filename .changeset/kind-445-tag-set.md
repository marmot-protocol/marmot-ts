---
"@internet-privacy/marmot-ts": patch
---

`GroupsManager` now drops a kind-445 event whose tags are anything other than the single `h`
tag plus at most one NIP-40 `["expiration", <unsigned integer>]` tag, reporting it as a
`tag-cardinality` rejection before ingest (`transports/nostr.md` "Group message delivery").
MDK already drops these before decryption, so a member could otherwise show marmot-ts users
messages that White Noise users never see.
