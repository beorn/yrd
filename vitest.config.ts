import { cpus } from "node:os"
import { defineConfig } from "vitest/config"
import { resolveVitestMaxWorkers } from "./vitest-workers.ts"

// bun:sqlite (and any other bun:* built-in) must never be transformed/
// bundled by Vite's resolver — it only exists inside the Bun runtime.
// Externalizing it lets vite-node fall through to Bun's own `import()`.
export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    // Capped by default, exactly like the root, km and ag configs; the host is
    // shared with the live merge queue. See vitest-workers.ts for the policy.
    maxWorkers: resolveVitestMaxWorkers(process.env, cpus().length),
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
