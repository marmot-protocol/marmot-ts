---
"@internet-privacy/marmot-ts": patch
---

Enforce the 16-relay limit on `marmot.transport.nostr.routing.v1` when encoding and decoding.
A group created or updated with more relays was rejected by MDK/White Noise members (the Welcome
is dropped and the commit fails validation), and a 17-relay state from a peer was accepted here
while MDK rejected it.
