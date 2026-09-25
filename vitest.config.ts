import { cpus } from "node:os"
import { defineConfig } from "vitest/config"
import { pinYrdTestStateHome } from "./tests/support/state-home.ts"
import { resolveVitestMaxWorkers } from "./vitest-workers.ts"

// Before any worker: XDG_STATE_HOME and the bun install cache point at a
// throwaway root (25256), so a fixture that sets no yrd.workdir cannot send its
// queue-owned clone to the operator's ~/.local/state/yrd from any spawn shape.
pinYrdTestStateHome()

// bun:sqlite (and any other bun:* built-in) must never be transformed/
// bundled by Vite's resolver — it only exists inside the Bun runtime.
// Externalizing it lets vite-node fall through to Bun's own `import()`.
export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    // Removes the pinned state root after the run (the pin itself is above).
    globalSetup: ["./tests/support/state-home.ts"],
    // Capped by default, exactly like the root, km and ag configs; the host is
    // shared with the live merge queue. See vitest-workers.ts for the policy.
    maxWorkers: resolveVitestMaxWorkers(process.env, cpus().length),
    // Wall-clock, like the host monorepo's ceiling for the same files. yrd's real-git tests (a queue round, a
    // composed carrier) take 2-5 s each and measured up to 9.1 s at load 39 with no limit (tests/gitlink.test.ts,
    // 135 runs, p99 8.9 s), so vitest's 5 s default failed 2-9 of 45 by load alone (bead 25078). 30 s keeps a hang
    // failing fast.
    testTimeout: 30_000,
    // `.slow.` drills sample real elapsed CPU over minute-long windows. They are
    // a separate suite (`bun run test:slow`) so an ordinary run stays fast.
    exclude: ["**/node_modules/**", "**/*.slow.*"],
    server: {
      deps: {
        external: [/^bun:/],
      },
    },
  },
})
