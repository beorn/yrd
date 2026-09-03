import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { gitIn } from "../src/git.ts"

function scratch(name: string): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `yrd-git-runner-${name}-`))
}

describe("the git runner", () => {
  it("never recurses a fetch into submodules, whatever the repository's config says", async () => {
    // A superproject with one submodule whose remote is unreachable, under
    // `submodule.recurse=true` as the root's checkout has it. A plain fetch
    // recurses and fails on the submodule; the runner's fetch does not recurse.
    const root = scratch("recurse")
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
  })

  it("answers for its own repository even when the caller's GIT_DIR points elsewhere", async () => {
    const root = scratch("gitdir")
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
