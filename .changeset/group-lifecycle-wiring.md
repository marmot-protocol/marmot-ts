---
"@internet-privacy/marmot-ts": minor
---

MarmotGroup now tracks its group-state lifecycle (exposed via group.lifecycle): a commit may only be prepared while Stable and moves through PendingPublish and Merging back to Stable, resetting to Stable if the publish obligation fails.
