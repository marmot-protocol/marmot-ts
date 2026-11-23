import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const librarySrc = fileURLToPath(new URL("../../src", import.meta.url));

// Point the package at the library *source* so the demos exercise the code in
// this checkout with HMR, no `pnpm build` required. Set MARMOT_DIST=1 to run
// against the built `dist/` instead, exactly as a downstream app would.
const useDist = process.env.MARMOT_DIST === "1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: useDist
      ? []
      : [
          {
            find: /^@internet-privacy\/marmot-ts$/,
            replacement: `${librarySrc}/index.ts`,
          },
          {
            find: /^@internet-privacy\/marmot-ts\/(.+)$/,
            replacement: `${librarySrc}/$1/index.ts`,
          },
        ],
  },
  build: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
