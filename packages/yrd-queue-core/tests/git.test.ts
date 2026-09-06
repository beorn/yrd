import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createProcess, type Process, type ProcessResult } from "@yrd/process"
import { gitIn } from "../src/git.ts"
import { prepareComponents } from "../src/components.ts"

function temporaryRoot(name: string): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `yrd-git-runner-${name}-`))
}

describe("the git runner", () => {
  // These are process-protocol failures, not a fake Git store. A successful
  // real-repository journey cannot prove what survives a broken CLI result.
  it.each([
    { name: "nonzero exit", exitCode: 2, stdout: '{"state":"failed"}', timedOut: false },
    { name: "malformed JSON", exitCode: 0, stdout: '{"state":', timedOut: false },
    { name: "timeout", exitCode: 0, stdout: '{"state":"unchanged"}', timedOut: true },
  ])("retains the command identity and both raw streams after $name during component preparation", async (fault) => {
    const root = temporaryRoot("prepare-protocol")
    const commit = "a".repeat(40)
    const response: ProcessResult = {
      durationMs: 1,
      exitCode: fault.exitCode,
      signal: null,
      stderr: "component preparation diagnostic",
      stdout: fault.stdout,
      stalled: false,
      timedOut: fault.timedOut,
    }
    await using real = createProcess({ cwd: root })
    const failing: Process = {
      ...real,
      async run(request) {
        expect(request.argv).toEqual([
          "git",
          "super",
          "--json",
          "--repo",
          root,
          "submodule",
          "prepare",
          commit,
          "--remote",
          "origin",
        ])
        return response
      },
    }

    const preparation = prepareComponents(root, commit, "origin", failing)

    await expect(preparation).rejects.toMatchObject({
      cause: response,
      message: expect.stringContaining("submodule prepare"),
    })
    await expect(preparation).rejects.toThrow(root)
  })

  it("never recurses a fetch or a push into submodules, whatever the repository's config says", async () => {
    // A superproject with one submodule whose remote is unreachable, under
    // `submodule.recurse=true` as the root's checkout has it. A plain fetch
    // recurses and fails on the submodule; the runner's fetch does not recurse.
    const root = temporaryRoot("recurse")
    const sub = join(root, "sub")
    const remote = join(root, "remote.git")
    const main = join(root, "main")
    const plain = (cwd: string, args: string[]) =>
      spawnSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" })
    plain(root, ["init", "-q", "-b", "main", sub])
    plain(sub, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "sub"])
    plain(root, ["init", "-q", "--bare", "-b", "main", remote])
    plain(root, ["init", "-q", "-b", "main", main])
    plain(main, ["submodule", "add", "-q", sub, "sub"])
    plain(main, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main with sub"])
    plain(main, ["remote", "add", "origin", remote])
    plain(main, ["push", "-q", "origin", "main"])
    plain(main, ["config", "submodule.recurse", "true"])
    plain(main, ["config", "submodule.sub.url", join(root, "gone")])
    plain(main, ["-C", "sub", "remote", "set-url", "origin", join(root, "gone")])
    const control = plain(main, ["fetch", "origin"])
    expect(control.status, `the control fetch was expected to recurse and fail: ${control.stderr}`).not.toBe(0)
    await expect(gitIn(main)(["fetch", "origin"])).resolves.toBe("")
    // The same for a push: the superproject commit moves the gitlink to a commit
    // the submodule's remote does not have. Under `submodule.recurse=true` a
    // plain push recurses on demand into the submodule, whose remote is
    // unreachable, and fails; the runner's push does not recurse.
    plain(join(main, "sub"), [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "sub moved",
    ])
    plain(main, ["add", "sub"])
    plain(main, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moves the gitlink"])
    const pushControl = plain(main, ["push", "-q", "origin", "main:refs/heads/control"])
    expect(pushControl.status, `the control push was expected to recurse and fail: ${pushControl.stderr}`).not.toBe(0)
    await expect(gitIn(main)(["push", "-q", "origin", "main:refs/heads/runner"])).resolves.toBe("")
  })

  it("answers for its own repository even when the caller's GIT_DIR points elsewhere", async () => {
    const root = temporaryRoot("gitdir")
    const git = gitIn(root)
    await git(["init", "-q", "-b", "main"])
    process.env.GIT_DIR = join(root, "not-a-repository")
    try {
      expect((await git(["rev-parse", "--git-dir"])).trim()).toBe(".git")
    } finally {
      delete process.env.GIT_DIR
    }
  })
})
