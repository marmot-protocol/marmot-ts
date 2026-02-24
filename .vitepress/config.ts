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
      { text: "Guide", link: "/guide/architecture" },
      { text: "Core", link: "/core/" },
      { text: "Client", link: "/client/" },
    ],

    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "Getting Started", link: "/getting-started" },
          { text: "Architecture", link: "/guide/architecture" },
        ],
      },
      {
        text: "Marmot Client",
        items: [
          { text: "Overview", link: "/client/" },
          { text: "MarmotClient", link: "/client/marmot-client" },
          { text: "MarmotGroup", link: "/client/marmot-group" },
          { text: "UI Framework Integration", link: "/client/ui-frameworks" },
          { text: "Proposals", link: "/client/proposals" },
          { text: "History", link: "/client/history" },
          { text: "Network", link: "/client/network" },
          { text: "Storage", link: "/client/storage" },
          { text: "Best Practices", link: "/client/best-practices" },
        ],
      },
      {
        text: "Core Module",
        items: [
          { text: "Overview", link: "/core/" },
          { text: "Protocol & Concepts", link: "/core/protocol" },
          { text: "Credentials", link: "/core/credentials" },
          { text: "Key Packages", link: "/core/key-packages" },
          { text: "Groups", link: "/core/groups" },
          { text: "Messages", link: "/core/messages" },
          { text: "Members", link: "/core/members" },
          { text: "Welcome Messages", link: "/core/welcome" },
          { text: "Key Package Distribution", link: "/core/distribution" },
          { text: "Client State", link: "/core/state" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/marmot-protocol/marmot-ts" },
    ],
  },
});
