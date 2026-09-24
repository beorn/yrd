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
import { legacyTrailers } from "../src/legacy-records.ts"

// Every id below hashes a committer (yrd@hostname) and an author (the ambient GIT_AUTHOR_*),
// so both are pinned here: an id must not depend on which host or which identity runs the test.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  hostname: () => "legacy-bytes-host",
}))

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

it("matches Git's legacy trailer projection at whitespace and body boundaries", () => {
  expect(legacyTrailers("subject\n\nRecord: opened   \nChange: task/one\t \n")).toEqual([
    ["Record", "opened"],
    ["Change", "task/one"],
  ])
  expect(legacyTrailers("subject\n\nnot a trailer\nRecord: opened\nChange: task/one\n")).toEqual([])
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
  vi.stubEnv("GIT_AUTHOR_NAME", "legacy bytes")
  vi.stubEnv("GIT_AUTHOR_EMAIL", "legacy-bytes@yrd.test")
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
      // #25429 intentionally renamed the queue committer from yrd-service to yrd. Re-pinned when the
      // author and host became fixed: the previous pins reproduce exactly under the pinning author's ambient
      // identity on its host, so the record bytes did not change.
      candidate: "081d24c2bcdb61e5412c4baff5fde2ed38ea0a2f",
      checked: "639945bac3a0f38bec8329e3e3822b0569ffb27a",
      genesis: "538f8f98bbb84332337777f997139c8464b80cd9",
      head: "0ffe80543cd9aa3049e5406b7398475a87108645",
      opened: "fa97e96140d3942685a3e46ddc69a3d2539f4c2a",
      paused: "4afcea1ffa49ab213107241c82347048f4815c85",
      resumed: "ce0037ab1c8989ddee16f4c25bd5b20b3ad00e75",
      retainedHead: "0ffe80543cd9aa3049e5406b7398475a87108645",
    })
  } finally {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  }
})
