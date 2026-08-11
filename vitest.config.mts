import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    // Node only. Everything under test here is pure logic — the pond registry,
    // the advisors, the fishing geometry — which is the part that kept breaking
    // silently and the part worth pinning down.
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
