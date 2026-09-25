/**
 * @failure `yrd queue health` asks GitHub for the default branch on every tick (156 sessions an hour
 *          upstream, hh 25626), although the clone already records it in refs/remotes/<remote>/HEAD
 * @level   l2
 * @consumer queue-location.ts resolveQueueLocation, workdir.ts, env-commands.ts, queue-core-commands.ts
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { gitIn } from "@yrd/queue-core"
import { originHead, resolveQueueLocation } from "../src/queue-location.ts"

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A real upstream whose default branch is `branch`, and a real clone of it. */
function cloned(branch: string): { root: string; upstream: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "yrd-origin-head-"))
  roots.push(root)
  const upstream = join(root, "upstream")
  git(root, "init", "-q", "-b", branch, upstream)
  git(upstream, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "c")
  git(root, "clone", "-q", upstream, "clone")
  return { root, upstream, clone: join(root, "clone") }
}

describe("originHead (hh 25626)", () => {
  it("reads the branch the clone recorded for origin/HEAD, and never asks the remote", async () => {
    const { root, upstream, clone } = cloned("trunk")
    expect(git(clone, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/trunk")
    // The remote is gone: any ls-remote now fails, so an answer proves no remote was asked.
    renameSync(upstream, join(root, "gone"))
    await expect(originHead(gitIn(clone))).resolves.toBe("trunk")
  })

  it("asks the remote only when the clone recorded no origin/HEAD, and fails loud when it cannot", async () => {
    const { root, upstream, clone } = cloned("main")
    git(clone, "remote", "set-head", "origin", "-d")
    await expect(originHead(gitIn(clone))).resolves.toBe("main")
    renameSync(upstream, join(root, "gone"))
    await expect(originHead(gitIn(clone))).rejects.toThrow(/ls-remote/u)
  })

  it("an address without # outside any repository asks that address for its default branch (@dev/review2 P3)", async () => {
    // A path or URL can never be a remote name, so there is no recorded HEAD to read, and outside a
    // repository a local read cannot even run: this address resolves as it did before 25626.
    const { root, upstream } = cloned("trunk")
    const outside = mkdtempSync(join(tmpdir(), "yrd-origin-head-outside-"))
    roots.push(outside)
    const location = await resolveQueueLocation(outside, upstream, {
      ...process.env,
      XDG_STATE_HOME: join(root, "state"),
    })
    expect(location.address?.queue ?? location.queue).toBe("trunk")
  })
})
