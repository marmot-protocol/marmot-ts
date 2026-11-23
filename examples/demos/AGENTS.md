# Demo Guidelines

- Follow a **show, don't tell** approach: demonstrate behavior through working controls, live state, and results rather than descriptive text.
- Keep demos focused on clean code and functionality. Avoid introductory paragraphs, tutorials, and redundant explanations in the UI.
- Use concise labels, statuses, empty states, and actionable errors. Include explanatory text only when essential to using the demo safely or correctly.
- Keep library calls easy to follow in the demo source; put longer explanations in the README or documentation instead.
- Use `useTransport()` for the shared, mode-aware Nostr transport and its relay URLs; use `useContacts()` for mode-aware contacts rather than creating per-demo services.
- Default to local tabs mode. Never bridge local events, identities, or group state into live mode; switching modes must dispose and reset the demo session.
- Persist the active account only in sessionStorage so reloads keep the tab's identity. New sessions generate a development identity and publish its randomly named kind-0 profile only to the local worker relay.
- Offer a header **Copy code** button, not an inline source viewer.
