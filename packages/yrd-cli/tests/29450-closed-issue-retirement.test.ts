/**
 * @failure Automatic retirement deletes an unmerged/advanced head from an issue status or tree equality, loses archive custody, or ignores a hold.
 * @level l2 (temporary real Git remote and event queue)
 * @consumer Yrd post-merge retirement
 * @testonly none
 * @reach fs-walk <fixture-only: temporary Git repositories>
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  changeInput,
  changesRef,
  createEventQueue,
  createEventStore,
  readConfig,
  readEventQueue,
  readStatus,
  type LocalBranchRetirement,
  type LogRecord,
} from "@yrd/queue-core"
import { openEvents } from "gitomic/events"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { retireMergedRootAuthor } from "../src/branch-retirement.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

async function world(config = "{}\n"): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-29450-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(repo, "README.md"), "queue\n")
  writeFileSync(join(repo, ".yrd.yml"), config)
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const queueConfig = await readConfig(git, target, { branch: "main", remote: "origin" })
  if (queueConfig === undefined) throw new Error("fixture lost .yrd.yml")
  await createEventQueue(createEventStore(repo, "origin", git.selection), "main", target, queueConfig, new Date())
  return repo
}

/** A branch off main with one commit bound to `issue` by its Refs trailer; returns the tip. */
async function branchFor(repo: string, branch: string, issue: string): Promise<string> {
  const git = gitIn(repo)
  await git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(repo, `${branch.replace(/\//gu, "-")}.txt`), branch)
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", `work on ${branch}\n\nRefs: ${issue}`])
  const tip = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])
  return tip
}

/** Record a change on the queue's chain for `branch` at `tip`, bound to `issue`: open, or ended as named. */
async function recordChange(
  repo: string,
  branch: string,
  tip: string,
  issue: string | undefined,
  ending?: "merged" | "withdrawn",
): Promise<void> {
  const git = gitIn(repo)
  const store = createEventStore(repo, "origin", git.selection)
  const queueTip = (await readEventQueue(store, "main")).tip
  if (queueTip === null) throw new Error("fixture queue has no tip")
  const at = new Date()
  const chain = await openEvents({ ...store, ref: changesRef("main", branch), writer: "fixture" })
  const events = [changeInput("opened", { queueTip, at, commit: tip, by: "fixture", issue })]
  if (ending === "merged") events.push(changeInput("merged", { queueTip, at, commit: tip }))
  if (ending === "withdrawn") events.push(changeInput("cancelled", { queueTip, at, commit: tip, reason: "withdrawn" }))
  await chain.append(events, { expect: null })
}

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string; stdout(): string }> {
  let stderr = ""
  let stdout = ""
  return {
    io: { color: false, cwd, stderr: (text) => void (stderr += text), stdout: (text) => void (stdout += text) },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

function collector(): { rows: LogRecord[]; log: LocalBranchRetirement["log"] } {
  const rows: LogRecord[] = []
  return {
    rows,
    log: {
      write(record) {
        const row = { ...record, run: "fixture", at: new Date().toISOString() } as LogRecord
        rows.push(row)
        return row
      },
    },
  }
}
async function retire(repo: string, branch: string, protections: NonNullable<YrdCliIO["localBranchProtections"]>) {
  const git = gitIn(repo),
    out = capture(repo),
    { rows, log } = collector()
  const target = (await git(["rev-parse", "origin/main"])).trim()
  const store = createEventStore(repo, "origin", git.selection)
  const result = await retireMergedRootAuthor({
    repo,
    git,
    branch,
    change: await readStatus(store, "main", branch),
    base: target,
    store,
    queue: "main",
    target,
    io: { ...out.io, localBranchProtections: protections },
    log,
    actor: "fixture",
  })
  return { result, git, rows }
}
const idle: NonNullable<YrdCliIO["localBranchProtections"]> = async () => ({ protections: [], evidence: [] })

describe("automatic retirement is licensed by exact-head ancestry", () => {
  /**
   * @failure An issue-less merged source outside task/exp stays silently when its graph is not on target.
   * @level l2
   * @consumer the owner who must receive the named KEEP flag without optional issue metadata
   * @testonly none
   */
  it("flags an issue-less non-task graph-only source kept for owner review", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const branch = "repair/rebuilt"
    const target = (await git(["rev-parse", "origin/main"])).trim()
    await git(["checkout", "--quiet", "-b", branch, "main"])
    await git(["commit", "--quiet", "--allow-empty", "-m", "graph-only source"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    expect((await git(["rev-parse", `${head}^{tree}`])).trim()).toBe(
      (await git(["rev-parse", `${target}^{tree}`])).trim(),
    )
    await recordChange(repo, branch, head, undefined, "merged")
    const store = createEventStore(repo, "origin", git.selection)
    const change = await readStatus(store, "main", branch)
    expect(change.issue).toBeUndefined()
    const out = capture(repo)
    const { rows, log } = collector()
    const result = await retireMergedRootAuthor({
      repo,
      git,
      branch,
      change,
      base: target,
      target,
      actor: "fixture",
      io: { ...out.io, localBranchProtections: idle },
      log,
      store,
      queue: "main",
    })
    expect(result).toMatchObject({ outcome: "kept", reason: "unreached" })
    expect((await git(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(head)
    expect((await git(["for-each-ref", "--format=%(refname)", "refs/archive/"])).trim()).toBe("")
    expect(rows).toContainEqual(
      expect.objectContaining({ kind: "local-branch-retirement", branch, head, outcome: "kept", reason: "unreached" }),
    )
    expect(out.stderr()).toContain(`${branch}@${head}`)
    expect(out.stderr()).toContain("owner review")
  })

  it("archives a targeted ancestor and keeps targeted unmerged or graph-only heads", async () => {
    const repo = await world()
    const merged = await branchFor(repo, "task/29100-merged", "opaque-key")
    await recordChange(repo, "task/29100-merged", merged, "opaque-key", "merged")
    const git = gitIn(repo)
    await git(["merge", "--quiet", "--ff-only", "task/29100-merged"])
    await git(["push", "--quiet", "origin", "main"])
    const unmerged = await branchFor(repo, "task/29101-unmerged", "other-key")
    await recordChange(repo, "task/29101-unmerged", unmerged, "other-key", "merged")
    await git(["checkout", "--quiet", "-b", "task/29267-graph-only", "main"])
    await git(["commit", "--quiet", "--allow-empty", "-m", "graph-only e81f7ace class"])
    const graph = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    expect((await git(["rev-parse", graph + "^{tree}"])).trim()).toBe((await git(["rev-parse", "main^{tree}"])).trim())
    await recordChange(repo, "task/29267-graph-only", graph, "graph-key", "merged")
    const landed = await retire(repo, "task/29100-merged", idle)
    expect(landed.result.outcome).toBe("removed")
    for (const branch of ["task/29101-unmerged", "task/29267-graph-only"]) {
      expect((await retire(repo, branch, idle)).result).toMatchObject({ outcome: "kept", reason: "unreached" })
    }
    const archive = landed.result.archiveRef
    expect(archive).toBeTruthy()
    expect((await git(["rev-parse", archive!])).trim()).toBe(merged)
    expect((await git(["for-each-ref", "--format=%(objectname)", "refs/heads/task/29100-merged"])).trim()).toBe("")
    expect((await git(["rev-parse", "refs/heads/task/29267-graph-only"])).trim()).toBe(graph)
  })
  it("keeps explicit holds and a branch advanced after its archive", async () => {
    const repo = await world()
    const branch = "task/29100-held"
    const head = await branchFor(repo, branch, "opaque")
    await recordChange(repo, branch, head, "opaque", "merged")
    const git = gitIn(repo)
    await git(["merge", "--quiet", "--ff-only", branch])
    await git(["push", "--quiet", "origin", "main"])
    const held = await retire(repo, branch, async () => ({ protections: ["explicit hold"], evidence: [] }))
    expect(held.result.outcome).toBe("kept")
    expect(held.result.detail).toContain("explicit hold")
    const advanced = (await git(["commit-tree", head + "^{tree}", "-p", head], "advanced\n")).trim()
    let protectionReads = 0
    const raced = await retire(repo, branch, async () => {
      if (++protectionReads === 2) {
        expect((await git(["rev-parse", held.result.archiveRef])).trim()).toBe(head)
        await git(["update-ref", "refs/heads/" + branch, advanced, head])
      }
      return { protections: [], evidence: [] }
    })
    expect(protectionReads).toBe(2)
    expect(raced.result.outcome).toBe("kept")
    expect(raced.result.detail).toContain("branch moved")
    expect((await git(["rev-parse", "refs/heads/" + branch])).trim()).toBe(advanced)
  })
})
