---
"@internet-privacy/marmot-ts": minor
---

Application messages sent in a group with `message-retention.v1` enabled now carry the NIP-40
`expiration` tag on their kind-445 event, set to the inner `created_at` plus the retention
seconds of the source epoch (`transports/nostr.md` "Message expiration"). Commits and
proposals never carry it. The tag is omitted when retention is off, the inner `created_at` is
not a safe integer, or the sum overflows uint64. MDK already tags its messages this way.
`GroupPeeler.wrapGroupMessage` takes an optional third `GroupMessageWrapOptions` argument and
`createGroupEvent` an optional `expiration`.
