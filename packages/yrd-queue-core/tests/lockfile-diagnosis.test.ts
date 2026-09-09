/**
 * `frozenLockfileDiagnosis` in isolation, against real files and real child
 * processes but without a real `bun install`: each case writes the lockfile
 * text it wants read, and drives the "re-resolve" step with a small shell
 * command standing in for it. The end-to-end shape — a real `bun install
 * --frozen-lockfile` actually refusing — is run.test.ts's
 * "the target's setup" describe block (@i/10-yrd/24140).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { frozenLockfileDiagnosis } from "../src/lockfile-diagnosis.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "yrd-lockfile-diagnosis-"))
  roots.push(root)
  return root
}

describe("frozenLockfileDiagnosis", () => {
  it("is undefined when the failing command never named --frozen-lockfile", async () => {
    // A bogus cwd proves this returns before touching the filesystem at all —
    // an ordinary setup failure (a failing test, a missing build step) must
    // cost this diagnosis nothing.
    const result = await frozenLockfileDiagnosis({ cwd: "/does/not/exist", setupRun: "bun test" })
    expect(result).toBeUndefined()
  })

  it("says loudly, and names the path, when the flag is named but no lockfile exists to compare", async () => {
    const cwd = dir()
    const result = await frozenLockfileDiagnosis({ cwd, setupRun: "bun install --frozen-lockfile" })
    expect(result).toContain(join(cwd, "bun.lock"))
    expect(result).toContain("no bun.lock exists")
  })

  it("says loudly, with the re-resolve's own exit, when re-resolving without the flag itself fails", async () => {
    const cwd = dir()
    writeFileSync(join(cwd, "bun.lock"), '{"packages": {}}')
    // Stripping "--frozen-lockfile" leaves `sh -c 'exit 7'`, a real command
    // that fails on its own — standing in for a re-resolve that cannot
    // succeed either (a broken registry, a permissions problem).
    const result = await frozenLockfileDiagnosis({ cwd, setupRun: "sh -c 'exit 7' --frozen-lockfile" })
    expect(result).toContain("exited 7")
    expect(result).toContain(join(cwd, "bun.lock"))
    expect(result).toContain(`worktree root ${cwd}`)
  })

  it("says loudly, rather than guessing, when the re-resolved lockfile does not parse", async () => {
    const cwd = dir()
    writeFileSync(join(cwd, "bun.lock"), '{"packages": {}}')
    writeFileSync(join(cwd, "after.lock"), "not json at all")
    const result = await frozenLockfileDiagnosis({
      cwd,
      setupRun: "sh -c 'cp after.lock bun.lock' --frozen-lockfile",
    })
    expect(result).toContain("could not parse")
    expect(result).toContain(join(cwd, "bun.lock"))
  })

  it("names an added, a removed, and a changed entry, each with its before and after specifier", async () => {
    const cwd = dir()
    writeFileSync(
      join(cwd, "bun.lock"),
      JSON.stringify({
        packages: {
          gone: ["gone@1.0.0", {}],
          moved: ["moved@1.0.0", {}],
          steady: ["steady@1.0.0", {}],
        },
        workspaces: { "": { name: "root" } },
      }),
    )
    writeFileSync(
      join(cwd, "after.lock"),
      JSON.stringify({
        packages: {
          moved: ["moved@2.0.0", {}],
          new: ["new@1.0.0", {}],
          steady: ["steady@1.0.0", {}],
        },
        workspaces: { "": { name: "root" } },
      }),
    )
    const result = await frozenLockfileDiagnosis({
      cwd,
      setupRun: "sh -c 'cp after.lock bun.lock' --frozen-lockfile",
    })
    expect(result).toBeDefined()
    // Changed, named with both specifiers either side of the arrow.
    expect(result).toContain("moved: moved@1.0.0 -> moved@2.0.0")
    // Added and removed are named too, never silently dropped from the diff.
    expect(result).toContain("new: (absent) -> new@1.0.0")
    expect(result).toContain("gone: gone@1.0.0 -> (absent)")
    // Untouched entries stay out of the report.
    expect(result).not.toContain("steady")
    // Where it looked: the lockfile, the manifest(s), the worktree root.
    expect(result).toContain(join(cwd, "bun.lock"))
    expect(result).toContain(join(cwd, "package.json"))
    expect(result).toContain(`worktree root ${cwd}`)
    // The lockfile on disk is left at the re-resolved (AFTER) state, as a real
    // unfrozen `bun install` would leave it — this diagnosis never re-freezes
    // or restores the worktree it just mutated; the caller's own cleanup owns
    // that (worktree.ts removes the whole disposable tree next).
    expect(readFileSync(join(cwd, "bun.lock"), "utf8")).toContain("new@1.0.0")
  })

  it("says so plainly when re-resolving changes nothing named", async () => {
    const cwd = dir()
    const identical = JSON.stringify({ packages: { steady: ["steady@1.0.0", {}] } })
    writeFileSync(join(cwd, "bun.lock"), identical)
    writeFileSync(join(cwd, "after.lock"), identical)
    const result = await frozenLockfileDiagnosis({
      cwd,
      setupRun: "sh -c 'cp after.lock bun.lock' --frozen-lockfile",
    })
    expect(result).toContain("came back identical")
    expect(result).toContain(join(cwd, "bun.lock"))
  })
})
