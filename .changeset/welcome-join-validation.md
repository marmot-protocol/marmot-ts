---
"@internet-privacy/marmot-ts": patch
---

Validate the group state a Welcome installs before joining, as MDK does: the Welcome author (the
GroupInfo signer) must be an admin, every admin must have a member leaf, every known component must
decode, every required component must be supported, present, and advertised by every member leaf, and the joining leaf must advertise
every required agent-text-stream role. A rejected Welcome persists nothing and leaves the KeyPackage
unconsumed. `readWelcomeGroupInfo()` now reports the real GroupInfo signer instead of the joiner's
own leaf index, and the new `joinWelcomeWithAuthor()` exposes it.
