/**
 * The stage breakdown is derived from spans, and that only holds while every
 * logger that can create a span has been wrapped.
 *
 * The first test pins the production wiring — the thing a reading of the source
 * alone got wrong once already. The second is the ratchet: a NEW `createLogger`
 * root added tomorrow is exactly how spans would start falling out of the
 * accounting again, silently, with the breakdown still printing a confident
 * `unaccountedMs`.
 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resetStageClock, stageReport } from "@yrd/core"
import { beforeEach, describe, expect, test } from "vitest"
import { createYrdLogger, resolveYrdObservability } from "../src/observability.ts"

beforeEach(() => {
  resetStageClock()
})

describe("stage accounting wiring", () => {
  test("a span on the host logger lands in the breakdown", async () => {
    // The operator's own invocation: DEBUG names one namespace, which is also
    // what turns spans on. Nothing else is enabled.
    const config = resolveYrdObservability({}, { DEBUG: "yrd:perf" })
    const log = createYrdLogger(config, () => {})
    {
      using _setup = log.child("setup").span?.(undefined, { phase: "pre-worktree" })
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const report = stageReport()
    expect(Object.keys(report.stages)).toContain("yrd:setup")
    expect(report.stages["yrd:setup"]).toBeGreaterThan(10)
    // The whole point: this time is no longer filed as nobody's.
    expect(report.accountedMs).toBeGreaterThan(10)
  })

  test("the breakdown prints only at levels where spans exist", () => {
    // If these two could disagree, the breakdown would report 100% unaccounted
    // at a level that creates no spans — worse than the defect it replaced.
    for (const env of [{ DEBUG: "yrd:perf" }, { LOG_LEVEL: "debug" }, { LOG_LEVEL: "trace" }]) {
      const config = resolveYrdObservability({}, env)
      expect(config.spans, `spans must be on for ${JSON.stringify(env)}`).toBe(true)
    }
    // And at the default level neither the breakdown nor the spans exist.
    expect(resolveYrdObservability({}, {}).spans).toBe(false)
  })

  test("every logger root in src is wrapped or knowingly standalone", async () => {
    // Roots that legitimately create their own logger. Each is either the
    // wrapped host fan-out, or an `inject.log ?? …` fallback used when no host
    // logger was handed in (tests, standalone entry) — in the CLI the host
    // injects, so the wrapped tree is what production uses.
    const known = new Set([
      "yrd-cli/src/observability.ts",
      "yrd-cli/src/host.ts",
      "yrd-core/src/app.ts",
      "yrd-persistence/src/lock.ts",
      "yrd-persistence/src/sqlite.ts",
      "yrd-process/src/index.ts",
      "yrd-queue/src/command.ts",
    ])
    const packages = fileURLToPath(new URL("../../", import.meta.url))
    const found = new Set<string>()
    for await (const entry of walk(packages)) {
      if (!/\/src\/.*\.tsx?$/u.test(entry)) continue
      const source = await readFile(entry, "utf8")
      if (!source.includes("createLogger(")) continue
      found.add(entry.slice(packages.length))
    }
    expect(found.size, "positive control: the known roots must still be findable").toBeGreaterThan(0)
    const unexpected = [...found].filter((file) => !known.has(file)).sort()
    expect(
      unexpected,
      "a new logger root creates spans the stage breakdown will not count. Wrap it with " +
        "withStageAccounting() from @yrd/core, or take the host logger via inject.log, then add it above.",
    ).toEqual([])
  })

  test("the host fan-out applies the wrapper", async () => {
    // Named separately from the ratchet above: observability.ts is allowed to
    // hold a root precisely BECAUSE it wraps it. If the wrap were dropped the
    // allowlist would still pass, and every span would silently stop counting.
    const source = await readFile(new URL("../src/observability.ts", import.meta.url), "utf8")
    expect(source).toContain("withStageAccounting(createLogger(")
  })
})

async function* walk(dir: string): AsyncGenerator<string> {
  const { readdir } = await import("node:fs/promises")
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue
    const path = `${dir}${entry.name}${entry.isDirectory() ? "/" : ""}`
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}
