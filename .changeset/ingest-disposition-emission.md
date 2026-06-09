---
"@internet-privacy/marmot-ts": minor
---

MarmotGroup.ingest now yields each result with its inbound-processing disposition attached, so callers receive the protocol-visible classification (accepted, stale, deferred, invalidated) without re-deriving it.
