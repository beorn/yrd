import { defineConfig } from "vitest/config"

// bun:sqlite (and any other bun:* built-in) must never be transformed/
// bundled by Vite's resolver — it only exists inside the Bun runtime.
// Externalizing it lets vite-node fall through to Bun's own `import()`.
export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    // Several suites spawn real git/subprocess work (queue recut, journal
    // migration replay, CLI bundle runs). Standalone — outside the monorepo's
    // warmed toolchain and under parallel CPU contention — these legitimately
    // exceed vitest's 5s default and time out non-deterministically. They
    // complete when given headroom, so this is marginal slowness, not a hang.
    testTimeout: 20000,
    server: {
      deps: {
        external: [/^bun:/],
      },
    },
  },
})
