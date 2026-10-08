---
"@internet-privacy/marmot-ts": patch
---

Check the current-profile invariants of every commit's complete resulting state, as MDK does on
every seam (`validate_current_profile_invariants_for_staged_commit`). Every resulting leaf must
advertise the required MLS capabilities and every required app component. The group must keep
requiring `app_data_dictionary`/`app_data_update`, admin policy and the account proof, every
required component must be a known component with state, and the frozen encrypted-media v1
component (`0x8008`) is not allowed. Before this change marmot-ts applied commits that MDK/White
Noise rejects, such as an Add of a KeyPackage that does not advertise a required component, or
an AppDataUpdate that requires a component some member lacks, and the group split. Because the
same check runs on the send path, marmot-ts now also refuses to make such commits itself,
including encrypted-media v1 updates.
