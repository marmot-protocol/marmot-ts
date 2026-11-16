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
      text: Concepts
      link: /guide/concepts
    - theme: alt
      text: View on GitHub
      link: https://github.com/marmot-protocol/marmot-ts

features:
  - title: End-to-End Encrypted
    details: Built on MLS (RFC 9420), with forward secrecy and post-compromise security for every group.
  - title: Decentralized
    details: Group messages, key packages and invites travel over ordinary Nostr relays. No central server.
  - title: Metadata Protection
    details: Group events are signed with fresh ephemeral keys, and invites are delivered as NIP-59 gift wraps.
  - title: Bring Your Own Infrastructure
    details: Plug in your own storage, Nostr relay client and message history backend.
  - title: High-Level Client
    details: MarmotClient handles key packages, invites, group sync and concurrent-commit convergence for you.
  - title: Marmot Protocol
    details: Implements the Marmot specification and interoperates with other Marmot clients.
---
