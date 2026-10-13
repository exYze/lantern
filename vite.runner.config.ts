// Bundles the hub runner (src/runner) into one self-contained file for Node 20+:
//   npm run build:runner  →  dist-runner/lantern-runner.mjs
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  publicDir: false,
  define: {
    __LANTERN_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    ssr: "src/runner/main.ts",
    outDir: "dist-runner",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: { entryFileNames: "lantern-runner.mjs", format: "es", inlineDynamicImports: true },
    },
  },
  ssr: { noExternal: true, target: "node" },
});
