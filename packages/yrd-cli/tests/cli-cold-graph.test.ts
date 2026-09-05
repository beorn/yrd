/**
 * @failure  The operator's condition on the watch (2026-09-05, 4658104f): the
 *           pane and its silvery stack load only when `yrd watch` draws. One
 *           value import of a `.tsx` module, of `react`, or of `silvery` from
 *           a command module would put ~670 modules and ~95 ms on the cold
 *           start of every `yrd list`, `submit`, `check`, `env` and of the
 *           service loop — and nothing would say so, because the commands
 *           would still work.
 * @consumer the operator at the prompt · `yrd queue up` under hab · every seat
 *           scripting `yrd list --json`
 *
 * The graph is read from the source, not the runtime: `import ... from` and
 * `export ... from` lines whose specifier is relative or names one of the
 * forbidden packages, `import type` excluded (erased), dynamic `import()`
 * excluded (that is the point — the pane is one). What stays in the cold path
 * on purpose is named in COLD_PATH_KEEPS so a future move shows up as a
 * diff, not a surprise.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const SRC = resolve(import.meta.dirname, "../src")

/** The entry of every command that is not the watch: the program builder wires them all. */
const ENTRIES = ["cli.ts", "queue-core-commands.ts", "env-commands.ts", "observability.ts"]

/**
 * The TUI stack: React, the reconciler, the component libraries, the `silvery`
 * barrel and its runtime. A specifier matches when it is the package or a
 * subpath of it.
 */
const TUI_STACK = [
  "react",
  "react-dom",
  "react-reconciler",
  "silvery",
  "@silvery/ag",
  "@silvery/ag-react",
  "@silvery/ag-term",
]

/**
 * Silvery packages the cold path keeps on purpose: the argument parser and the
 * ANSI string utilities it is built on (measured 2026-09-05: 154 modules,
 * 34 ms, of `yrd --version`'s 223 modules / ~100 ms). Not the pane's stack;
 * listed so the graph test says what it is NOT asserting.
 */
const COLD_PATH_KEEPS = ["@silvery/commander", "@silvery/ansi"]

const IMPORT_LINE = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']/gmu

function isTuiStack(specifier: string): boolean {
  return TUI_STACK.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))
}

function resolveRelative(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier)
  if (existsSync(target)) return target
  for (const ext of [".ts", ".tsx"]) if (existsSync(`${target}${ext}`)) return `${target}${ext}`
  throw new Error(`${from} imports ${specifier}, which resolves to nothing`)
}

/** Every module reachable from `entry` through static value imports inside this package, plus the bare specifiers seen. */
function staticGraph(entry: string): Readonly<{ modules: string[]; packages: string[] }> {
  const modules = new Set<string>()
  const packages = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || modules.has(file)) continue
    modules.add(file)
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(IMPORT_LINE)) {
      const specifier = match[1] ?? ""
      if (specifier.startsWith(".")) queue.push(resolveRelative(file, specifier))
      else packages.add(specifier)
    }
  }
  return { modules: [...modules].sort(), packages: [...packages].sort() }
}

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { force: true, recursive: true })
})

describe("the graph walker itself", () => {
  it("follows relative value imports, skips type-only and dynamic ones, and sees a .tsx and react when they are there", () => {
    const dir = mkdtempSync(join(tmpdir(), "yrd-cold-graph-"))
    scratch.push(dir)
    writeFileSync(
      join(dir, "a.ts"),
      'import { b } from "./b.ts"\nimport type { T } from "./typed.tsx"\nexport const a = () => import("./lazy.tsx")\n',
    )
    writeFileSync(join(dir, "b.ts"), 'import { c } from "./c.tsx"\nexport { c as b }\n')
    writeFileSync(join(dir, "c.tsx"), 'import { useState } from "react"\nexport const c = useState\n')
    writeFileSync(join(dir, "typed.tsx"), "export type T = number\n")
    writeFileSync(join(dir, "lazy.tsx"), 'import "silvery/runtime"\n')
    const graph = staticGraph(join(dir, "a.ts"))
    expect(graph.modules.map((file) => file.slice(dir.length + 1))).toEqual(["a.ts", "b.ts", "c.tsx"])
    expect(graph.packages).toEqual(["react"])
  })

  it("walks the real program: the environment commands are static from cli.ts, the queue commands are one dynamic import away", () => {
    const fromCli = staticGraph(join(SRC, "cli.ts"))
    const cliNames = fromCli.modules.map((file) => file.slice(SRC.length + 1))
    expect(cliNames).toContain("env-commands.ts")
    // The queue module (and the runtime identity fence it loads) is reached lazily, so `--help` and
    // `--version` never read git: the walker must not see it from cli.ts, and the source must import() it.
    expect(cliNames).not.toContain("queue-core-commands.ts")
    expect(readFileSync(join(SRC, "cli.ts"), "utf8")).toContain('await import("./queue-core-commands.ts")')
    const fromQueue = staticGraph(join(SRC, "queue-core-commands.ts"))
    const queueNames = fromQueue.modules.map((file) => file.slice(SRC.length + 1))
    expect(queueNames).toContain("watch-rows.ts")
    expect(queueNames).toContain("queue-stats.ts")
    expect(fromQueue.packages).toContain("@yrd/queue-core")
  })
})

describe("the cold path of every command but the watch (operator condition 4658104f)", () => {
  for (const entry of ENTRIES) {
    it(`${entry} reaches no .tsx module and no TUI-stack package through static imports`, () => {
      const graph = staticGraph(join(SRC, entry))
      const tsx = graph.modules.filter((file) => file.endsWith(".tsx"))
      expect(tsx, `.tsx modules reachable from ${entry}: ${tsx.join(", ")}`).toEqual([])
      const stack = graph.packages.filter(isTuiStack)
      expect(stack, `TUI-stack packages reachable from ${entry}: ${stack.join(", ")}`).toEqual([])
      // React's hook module is .ts, so the extension check alone would not catch it.
      expect(graph.modules.map((file) => file.slice(SRC.length + 1))).not.toContain("watch-clock.ts")
    })
  }

  it("the pane is reached only through a dynamic import, from the one place that draws it", () => {
    const commands = readFileSync(join(SRC, "queue-core-commands.ts"), "utf8")
    expect(commands).toContain('await import("./watch-pane.tsx")')
    expect(commands).toContain('await import("silvery/runtime")')
    expect(commands).toContain('await import("react")')
  })

  it("names what the cold path keeps from silvery, so a move there is a visible decision", () => {
    const kept = new Set<string>()
    for (const entry of ENTRIES) {
      for (const specifier of staticGraph(join(SRC, entry)).packages) {
        if (specifier === "silvery" || specifier.startsWith("silvery/") || specifier.startsWith("@silvery/")) {
          kept.add(specifier)
        }
      }
    }
    expect([...kept].sort()).toEqual([...COLD_PATH_KEEPS].sort())
  })
})
