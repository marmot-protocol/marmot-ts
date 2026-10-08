---
"@internet-privacy/marmot-ts": patch
---

Same-epoch fork resolution now ranks branches the way `convergence.md` and MDK do. Branch
selection skipped `tip_priority`, so an admin's commit (rename, invite, removal, admin
change) lost a tied race to a self-update or SelfRemove commit from a member whose key sorted
lower. The re-scoring pass over the persisted fork history also ran after every ingest
without the tip committer or priority, so it fell through to the commit digest and could
switch the group to a different branch than the one pool replay had just selected. In both
cases marmot-ts kept a different branch than MDK/White Noise members and the group split.
`BranchCandidate` gains an optional `tipPriority`, and `commitOrderingPriority` classifies a
commit's proposals.
