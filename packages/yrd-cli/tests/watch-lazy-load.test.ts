// @failure The interactive watch UI re-enters the eager module graph and forces every CLI path to
// resolve silvery's TUI-only SplitPane at load, bricking the CLI wherever that export is absent.
// @level l1
// @consumer yrd CLI boot path, standalone-published bundle

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const src = (relative: string): string =>
  readFileSync(resolve(import.meta.dirname, "..", relative), "utf8")

describe("watch UI lazy-load contract", () => {
  const run = src("src/run.ts")

  it("imports only types statically from the watch-pane module", () => {
    // A static value import would pull the watch UI (and silvery's SplitPane) into the module
    // graph of every command. The sole allowed static import from watch-pane is type-only.
    const staticImports = [...run.matchAll(/^import\s+(type\s+)?\{[^}]*\}\s+from\s+"\.\/watch-pane\.tsx"/gmu)]
    expect(staticImports).toHaveLength(1)
    expect(staticImports[0]?.[1], "watch-pane static import must be type-only").toBe("type ")
  })

  it("reaches the live watch UI through a dynamic import at its use site", () => {
    expect(run).toMatch(/await import\("\.\/watch-pane\.tsx"\)/u)
  })

  it("keeps the watch pane's own SplitPane import so the master-detail feature survives", () => {
    const watchPane = src("src/watch-pane.tsx")
    expect(watchPane).toMatch(/import\s*\{[^}]*\bSplitPane\b[^}]*\}\s*from\s*"silvery"/su)
  })

  it("builds the watch UI as a split chunk so the core bundle stays SplitPane-free", () => {
    expect(src("../../scripts/build.ts")).toMatch(/splitting:\s*true/u)
  })
})
