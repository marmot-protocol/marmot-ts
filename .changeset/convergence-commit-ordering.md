---
"@internet-privacy/marmot-ts": major
---

Resolve same-epoch commit races by the content-derived commit_digest (SHA-256 of the MLS message bytes) instead of transport created_at and event id, so ingest ordering is deterministic across implementations per the convergence spec.
