---
"@internet-privacy/marmot-ts": patch
---

An admin removed by another admin now accepts its removal. ts-mls hands a removed receiver a
tombstone that pairs the post-commit tree with the parent GroupContext, so the commit-legality
check saw the removed admin still listed in the admin policy with no leaf and rejected the
commit as an `admin-leaf-coupling` violation. The client kept presenting the group as active.
This happened whether MDK/White Noise or marmot-ts made the removal. For a removed receiver,
the resulting GroupContext extensions are now rebuilt from the commit's proposals before the
resulting-state checks run.
