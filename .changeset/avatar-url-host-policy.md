---
"@internet-privacy/marmot-ts": patch
---

`marmot.group.avatar-url.v1` no longer rejects URLs that point at localhost or a non-routable
address. The spec makes that a contact-time policy that must not affect validity, and MDK accepts
such URLs, so marmot-ts members rejected White Noise commits that set one and could not use groups
whose Welcome carried one. Use the new `rejectUnsafeGroupAvatarContactUrl()` before fetching or
rendering an avatar.
