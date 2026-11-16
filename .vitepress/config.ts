import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  srcDir: "docs",

  title: "Marmot-TS",
  description: "Privacy-preserving group messaging with MLS and Nostr",
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: "Home", link: "/" },
      { text: "Getting Started", link: "/getting-started" },
      { text: "Reference", link: "/reference/index.html", target: "_blank" },
    ],

    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "Getting Started", link: "/getting-started" },
          { text: "Concepts", link: "/guide/concepts" },
        ],
      },
      {
        text: "Setup",
        items: [
          { text: "Network", link: "/client/network" },
          { text: "Storage", link: "/client/storage" },
          { text: "Multiple Accounts", link: "/client/multi-account" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Key Packages", link: "/client/key-packages" },
          { text: "Groups", link: "/client/groups" },
          { text: "Invites", link: "/client/invites" },
          { text: "Messages", link: "/client/messages" },
          { text: "History", link: "/client/history" },
          { text: "Encrypted Media", link: "/client/media" },
          { text: "Group Images", link: "/client/group-images" },
          { text: "UI Frameworks", link: "/client/ui-frameworks" },
          { text: "Production Checklist", link: "/client/best-practices" },
        ],
      },
      {
        text: "Advanced",
        items: [
          { text: "Fork History", link: "/client/fork-history" },
          { text: "Low-level API", link: "/advanced/low-level" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/marmot-protocol/marmot-ts" },
    ],
  },
});
