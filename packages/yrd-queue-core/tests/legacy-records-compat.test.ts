/**
 * @failure Moving the legacy format changes a commit byte, so an existing
 *          Record: or pause ref gains a different object id for the same act.
 * @level   l1 (the legacy byte writer against one real repository)
 * @consumer The #25040 plumbing swap and the #25041 migration reader.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProcess } from "@yrd/process"
import { afterAll, expect, it, vi } from "vitest"
import { appendRecord, gitIn, writePause } from "../src/index.ts"
import { gitEnvironment } from "../src/git.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

it("keeps the exact legacy record and pause object ids under a fixed clock", async () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-legacy-bytes-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])

  const at = new Date("2026-09-22T12:34:56.000Z")
  const git = gitIn(
    work,
    createProcess({
      env: {
        ...gitEnvironment(process.env),
        GIT_AUTHOR_DATE: at.toISOString(),
        GIT_COMMITTER_DATE: at.toISOString(),
      },
    }),
  )
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])

  vi.useFakeTimers()
  vi.setSystemTime(at)
  try {
    const tree = (await git(["mktree"], "")).trim()
    const head = (await git(["commit-tree", tree, "-m", "change head"])).trim()
    const candidate = (await git(["commit-tree", tree, "-p", head, "-m", "candidate merge"])).trim()
    const change = { branch: "task/legacy-bytes", head }
    const opened = await appendRecord(git, "main", {
      change,
      kind: "opened",
      subject: "@dev/2 submitted task/legacy-bytes to main",
      trailers: [
        ["Submitter", "@dev/2"],
        ["Issue", "#25040"],
      ],
    })
    const [, genesis, retainedHead] = (await git(["rev-list", "--parents", "-n", "1", opened])).trim().split(/\s+/u)
    const checked = await appendRecord(git, "main", {
      change,
      kind: "checked",
      subject: "checks passed",
      trailers: [
        ["Merge", candidate],
        ["Check", "typecheck exit=0 ms=12 log=/tmp/typecheck.log"],
      ],
    })
    const paused = await writePause(git, "origin", "main", {
      by: "@chief",
      kind: "paused",
      reason: "fixed-clock pause",
    })
    const resumed = await writePause(git, "origin", "main", {
      by: "@chief",
      kind: "resumed",
      reason: "fixed-clock resume",
    })

    expect({
      candidate,
      checked,
      genesis,
      head,
      opened,
      paused: paused.sha,
      resumed: resumed.sha,
      retainedHead,
    }).toEqual({
      candidate: "917c4fed28a939a7e4c16cacf070306641541fa8",
      checked: "6b38dab6b4709170bfd27fb0d33ef8044aa0c868",
      genesis: "538f8f98bbb84332337777f997139c8464b80cd9",
      head: "591a78a8d7634696ba4aac046eb98e2e05bcc476",
      opened: "e9a72abd40b3942a356132f821fbcda698b1e14b",
      paused: "e8d10831f1a28d485ea6070b6b6dc94129fb19a6",
      resumed: "c7d6d84fa8acc1247864966ebad8d30e6a144838",
      retainedHead: "591a78a8d7634696ba4aac046eb98e2e05bcc476",
    })
  } finally {
    vi.useRealTimers()
  }
})
