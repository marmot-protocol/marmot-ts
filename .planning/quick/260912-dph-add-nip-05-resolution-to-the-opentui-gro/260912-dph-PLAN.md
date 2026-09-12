---
status: complete
task: Add NIP-05 resolution to the OpenTUI group invite modal
---

1. Add NIP-05 resolution to the shared Directory helper using Applesauce's DNS identity loader.
2. Resolve invite input as a pubkey/npub first, then as NIP-05, carrying DNS relay hints into KeyPackage discovery.
3. Update the invite prompt and add focused Bun tests for resolver outcomes.
4. Run the OpenTUI tests and TypeScript typecheck.
