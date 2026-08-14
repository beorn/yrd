import { defineConfig } from "vitest/config"

// bun:sqlite (and any other bun:* built-in) must never be transformed/
// bundled by Vite's resolver — it only exists inside the Bun runtime.
// Externalizing it lets vite-node fall through to Bun's own `import()`.
export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
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
