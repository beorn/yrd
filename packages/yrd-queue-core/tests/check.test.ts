/**
 * `runCheck`'s own write (check.ts): the last place a log's bytes can still
 * be protected. `exclusive` is the queue run's own contract — its `logDir` is
 * keyed by change, run and phase (run.ts) so this should never fire, and the
 * flag is the defense for when it does anyway: a second write to the same
 * path throws instead of silently replacing the first check's bytes.
 *
 * `yrd check <name>` (packages/yrd-cli) calls the same driver at one fixed,
 * deliberately-reused path across repeated invocations — the opposite
 * contract — so `exclusive` defaults off and a plain second write still
 * overwrites, proven here so nobody flips that default by accident.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { checkLogPath, runCheck } from "../src/index.ts"
import type { CheckedTree, CheckSpec } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const tree: CheckedTree = {
  base: "0000000000000000000000000000000000000000",
  candidate: "1111111111111111111111111111111111111111",
}

/** A fresh cwd/logDir/scratch, real directories `runCheck` can write under. */
function world(): Readonly<{ cwd: string; logDir: string; scratch: string }> {
  const root = mkdtempSync(join(tmpdir(), "yrd-core-check-"))
  roots.push(root)
  return { cwd: root, logDir: join(root, "checks"), scratch: join(root, "scratch") }
}

describe("runCheck's log write", () => {
  it("opening a log at an existing path throws with the path in the message, told to write exclusively", async () => {
    const w = world()
    const spec: CheckSpec = { name: "verify", run: "echo hello" }
    const path = checkLogPath(w.logDir, spec.name)

    const first = await runCheck({ cwd: w.cwd, exclusive: true, logDir: w.logDir, scratch: w.scratch, spec, tree })
    expect(first.result).toBe("pass")
    expect(readFileSync(path, "utf8")).toContain("hello")

    await expect(
      runCheck({ cwd: w.cwd, exclusive: true, logDir: w.logDir, scratch: w.scratch, spec, tree }),
    ).rejects.toThrow(path)

    // The throw happened at the write, after the first log was already on disk: it must survive untouched.
    expect(readFileSync(path, "utf8")).toContain("hello")
  })

  it("without exclusive, a second write still overwrites: yrd check's own fixed, reused path", async () => {
    const w = world()
    const path = checkLogPath(w.logDir, "verify")

    await runCheck({
      cwd: w.cwd,
      logDir: w.logDir,
      scratch: w.scratch,
      spec: { name: "verify", run: "echo first" },
      tree,
    })
    expect(readFileSync(path, "utf8")).toContain("first")

    await runCheck({
      cwd: w.cwd,
      logDir: w.logDir,
      scratch: w.scratch,
      spec: { name: "verify", run: "echo second" },
      tree,
    })
    expect(readFileSync(path, "utf8")).toContain("second")
  })
})
