import { defineConfig } from "vitest/config"

// bun:sqlite (and any other bun:* built-in) must never be transformed/
// bundled by Vite's resolver — it only exists inside the Bun runtime.
// Externalizing it lets vite-node fall through to Bun's own `import()`.
export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    // Standalone-environment timeouts. Several suites spawn real git/subprocess
    // work (queue recut, journal migration replay, CLI bundle runs). Outside the
    // monorepo's warmed toolchain — a cold Bun toolchain in a temp dir, on a
    // heavily shared machine (measured: load avg 21-26 on 18 cores) — a test
    // whose real work is ~5s is starved to 15s+ of wall clock. The slowest
    // *completed* test in isolation is ~4.5s, so these are marginal slowness
    // under CPU starvation, not hangs: they always finish when given headroom.
    // 45s absorbs ~10x starvation of the heaviest real test.
    testTimeout: 45_000,
    // afterEach/beforeEach hooks do recursive `rm` of temp git repos (many small
    // files); those out-run vitest's 10s default hookTimeout under the same load.
    hookTimeout: 45_000,
    poolOptions: {
      // Cap concurrent worker processes far below the 18-core count: the box is
      // already oversubscribed by the wider agent fleet (load avg 21-26), so
      // piling forks on top starves every git subprocess AND, under a spike, can
      // make fork() itself fail ("Failed to start forks worker" — the OS refusing
      // to spawn under pid/memory pressure). A low cap shrinks this run's process
      // footprint so each fork gets real CPU and worker spawns stay reliable.
      // Trade-off is longer wall time, which is fine for a green-signal run.
      forks: { minForks: 1, maxForks: 4 },
    },
    server: {
      deps: {
        external: [/^bun:/],
      },
    },
  },
})
