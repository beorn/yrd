/**
 * @failure A spawn whose working directory is absent fails inside posix_spawn with a bare ENOENT that names neither the directory nor the command, so callers cannot tell a missing cwd from a missing executable and no recovery path can contain it.
 * @level l1
 * @consumer @yrd/process
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createProcess, failureFact } from "@yrd/process"

async function absentDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-absent-cwd-"))
  const path = join(root, "km", "apps", "maddoc")
  await rm(root, { recursive: true, force: true })
  return path
}

describe("Process — an absent working directory", () => {
  it("raises one typed infrastructure failure naming the absolute path and the command", async () => {
    const cwd = await absentDirectory()
    await using process = createProcess({ env: { PATH: Bun.env.PATH } })

    const error = await process.run({ argv: ["git", "cat-file", "-e", `${"b".repeat(40)}^{commit}`], cwd }).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    // Typed, not a bare posix_spawn ENOENT: every recovery path in Yrd
    // classifies on the FailureFact, and an untyped throw is unclassifiable.
    expect(failureFact(error)).toMatchObject({ kind: "infrastructure", code: "spawn-cwd-missing" })
    // Loud enough to act on without a stack trace: the missing directory and the
    // command that wanted it.
    expect((error as Error).message).toContain(cwd)
    expect((error as Error).message).toContain("git cat-file -e")
  })

  it("still spawns normally when the working directory exists", async () => {
    // Positive control: the guard rejects absent directories only. A guard that
    // also rejected live callers would be the outage, not the fix.
    const cwd = await mkdtemp(join(tmpdir(), "yrd-present-cwd-"))
    await using process = createProcess({ env: { PATH: Bun.env.PATH } })

    await expect(process.run({ argv: ["pwd"], cwd })).resolves.toMatchObject({ exitCode: 0 })

    await rm(cwd, { recursive: true, force: true })
  })

  it("names the process-wide default when a run inherits an absent configured cwd", async () => {
    // The default cwd is captured once at createProcess() and reused by every
    // run that does not override it; it can be removed while the runtime is up.
    const cwd = await absentDirectory()
    await using process = createProcess({ cwd, env: { PATH: Bun.env.PATH } })

    const error = await process.run({ argv: ["git", "status"] }).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(failureFact(error)).toMatchObject({ kind: "infrastructure", code: "spawn-cwd-missing" })
    expect((error as Error).message).toContain(cwd)
  })
})
