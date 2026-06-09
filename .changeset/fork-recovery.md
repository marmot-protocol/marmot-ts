---
"@internet-privacy/marmot-ts": minor
---

MarmotGroup now performs convergence fork recovery: it retains canonical states within the rollback horizon and, when a competing commit for a past epoch arrives in a later ingest pass, rewinds to the retained parent and applies the canonical (lower commit_digest) branch, converging deterministically instead of dropping it.
