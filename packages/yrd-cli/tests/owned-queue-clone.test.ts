/**
 * @failure hh's cas-rejections reads a durable zero for the merging round because it looks for the round's lease
 *          journal somewhere other than the queue-owned clone the round composes in (hh 25626, @cto 30c9eaaa), or the
 *          lookup asks GitHub for the queue name and so adds to the session count it measures
 * @level   l1
 * @consumer hh tools/cas-rejections.ts (the merging round's journal home)
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ownedQueueClone, resolveQueueLocation } from "../src/queue-location.ts"

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A clone whose origin names a GitHub repository, with the real upstream gone: any remote read now fails. */
function offlineClone(): { root: string; clone: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), "yrd-owned-queue-clone-"))
  roots.push(root)
  const upstream = join(root, "upstream")
  git(root, "init", "-q", "-b", "main", upstream)
  git(upstream, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "c")
  git(root, "clone", "-q", upstream, "clone")
  const clone = join(root, "clone")
  git(clone, "remote", "set-url", "origin", "git@github.com:beorn/hh-dev.git")
  renameSync(upstream, join(root, "gone"))
  return { root, clone, state: join(root, "state") }
}

describe("ownedQueueClone (hh 25626)", () => {
  it("names the queue-owned clone from local records alone, as the queue resolves it", async () => {
    const { clone, state } = offlineClone()
    const env = { ...process.env, XDG_STATE_HOME: state }

    const owned = await ownedQueueClone(clone, env)

    expect(owned).toBe(join(state, "yrd", "github.com", "beorn", "hh-dev%23main", "repo"))
    // The same address and workdir the queue's own resolver answers (its reader path clones nothing).
    const location = await resolveQueueLocation(clone, undefined, env, "reader")
    expect(owned).toBe(join(location.workdir, "repo"))
  })

  it("follows the repository's yrd.workdir, as the live service does", async () => {
    const { root, clone } = offlineClone()
    const workdir = join(root, "declared-workdir")
    git(clone, "config", "yrd.workdir", workdir)

    await expect(ownedQueueClone(clone, { ...process.env })).resolves.toBe(
      join(workdir, "github.com", "beorn", "hh-dev%23main", "repo"),
    )
  })

  it("fails loud, naming the fix, when the clone records no origin/HEAD, rather than asking GitHub", async () => {
    const { clone, state } = offlineClone()
    git(clone, "remote", "set-head", "origin", "-d")

    await expect(ownedQueueClone(clone, { ...process.env, XDG_STATE_HOME: state })).rejects.toThrow(
      /records no refs\/remotes\/origin\/HEAD; run `git remote set-head origin --auto`/u,
    )
  })
})
