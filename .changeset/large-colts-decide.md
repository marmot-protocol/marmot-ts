---
"@internet-privacy/marmots": patch
---

Fix joinGroupFromWelcome() to not automatically send a self-update commit, which was causing the joining member to fork if there are pending commits
