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
    // 26906: the lockfile on disk goes BACK to the bytes the failed setup left.
    // The queue's worktree is disposable, but an `env open` environment failed
    // INTO RETENTION (25976) — the caller is told to inspect it, and cannot
    // tell its own starting bytes from this diagnosis's dependency change
    // unless the diagnosis is a pure observer.
    expect(readFileSync(join(cwd, "bun.lock"), "utf8")).not.toContain("new@1.0.0")
  })

  /**
   * @failure 26906: a setup-failed, retained environment's lockfile was left rewritten by the
   *          frozen-lockfile diagnosis, and the failure text never named the mutation.
   * @level l1 (real files and a real child process, no install)
   * @consumer every seat whose retained environment's setup fails a frozen install
   */
  it("leaves the tree it ran in byte-identical and names the rollback (26906)", async () => {
    const cwd = dir()
    const before = `${JSON.stringify({ packages: { moved: ["moved@1.0.0", {}] }, workspaces: { "": { name: "root" } } })}\n`
    writeFileSync(join(cwd, "bun.lock"), before)
    writeFileSync(
      join(cwd, "after.lock"),
      JSON.stringify({ packages: { moved: ["moved@2.0.0", {}] }, workspaces: { "": { name: "root" } } }),
    )
    const result = await frozenLockfileDiagnosis({
      cwd,
      setupRun: "sh -c 'cp after.lock bun.lock' --frozen-lockfile",
    })
    // It still names what moved ...
    expect(result).toContain("moved: moved@1.0.0 -> moved@2.0.0")
    // ... and puts the starting bytes back, so the tree it ran in is unchanged.
    expect(readFileSync(join(cwd, "bun.lock"), "utf8")).toBe(before)
    // The rollback is stated, never silent.
    expect(result).toContain("restored its starting bytes")
  })

  /**
   * @failure 26906: a re-resolve that FAILS (nonzero exit, timeout, signal) can already have
   *          rewritten the lockfile — `bun install` writes it before linking — so a retained
   *          environment would be left mutated even on the failure branch.
   * @level l1 (real files and a real child process, no install)
   * @consumer every seat whose retained environment's setup fails a frozen install
   */
  it("rolls back a FAILED re-resolve that had already rewritten the lockfile (26906)", async () => {
    const cwd = dir()
    const before = `${JSON.stringify({ packages: { moved: ["moved@1.0.0", {}] } })}\n`
    writeFileSync(join(cwd, "bun.lock"), before)
    writeFileSync(join(cwd, "after.lock"), JSON.stringify({ packages: { moved: ["moved@2.0.0", {}] } }))
    // Rewrite the lockfile, THEN fail — the order a real install can take.
    const result = await frozenLockfileDiagnosis({
      cwd,
      setupRun: "sh -c 'cp after.lock bun.lock && exit 9' --frozen-lockfile",
    })
    expect(result).toContain("exited 9")
    // The tree it ran in is unchanged, and the rollback is named, not silent.
    expect(readFileSync(join(cwd, "bun.lock"), "utf8")).toBe(before)
    expect(result).toContain("restored its starting bytes")
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
