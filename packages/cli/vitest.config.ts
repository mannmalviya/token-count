import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    // Give e2e tests that spawn the CLI a bit more headroom.
    testTimeout: 15000,
  },
});
