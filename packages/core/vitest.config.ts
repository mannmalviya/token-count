import { defineConfig } from "vitest/config";

// Vitest config for the core package.
// We just point it at our `tests/` tree. Vitest picks up any `*.test.ts`.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Each test should get a fresh environment — no cross-test leakage.
    clearMocks: true,
    restoreMocks: true,
  },
});
