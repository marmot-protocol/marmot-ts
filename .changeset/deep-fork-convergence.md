---
"@internet-privacy/marmot-ts": minor
---

Replace single-step fork recovery with a general DAG convergence resolver: MarmotGroup.ingest rebuilds candidate branches of arbitrary depth from retained states (decrypting a competing branch's children at the epochs replay reaches them), selects the canonical branch per the convergence policy, and rewinds to it — so the group converges onto a deeper competing branch even when its child commits are encrypted under an epoch never directly applied.
