import { defineConfig } from "vitest/config"

import base from "./vitest.config.ts"

// The `.slow.` drills sample real elapsed CPU over minute-long windows, so they
// are a suite of their own (`bun run test:slow`) rather than a tax on every run.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["**/*.slow.test.{ts,tsx}"],
    exclude: ["**/node_modules/**"],
  },
})
