---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "Marmot-TS"
  text: "Privacy-preserving group messaging"
  tagline: End-to-end encrypted group chat with MLS and Nostr
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/marmot-protocol/marmot-ts

features:
  - title: End-to-End Encrypted
    details: Built on MLS (RFC 9420) for group messaging security with forward secrecy and post-compromise security
  - title: Decentralized
    details: Uses Nostr relays for message distribution - no central server required, censorship-resistant
  - title: Privacy-First
    details: Ephemeral signing keys and gift-wrapped welcome messages protect metadata and provide unlinkability
  - title: Type-Safe
    details: Comprehensive TypeScript support with generic types for flexible, extensible implementations
  - title: Pluggable Architecture
    details: Bring your own storage, network layer, and history backends - works with any Nostr client library
  - title: Protocol Compliant
    details: Implements all Marmot Improvement Proposals (MIP-00 through MIP-03) for interoperability
---
