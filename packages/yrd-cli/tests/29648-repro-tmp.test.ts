/**
 * @failure Retirement cannot tell an absent protections reader from a reader proving no holds.
 * @level l2 (temporary real Git remote and event queue)
 * @consumer Yrd native branch retirement
 * @testonly none
 * @reach fs-walk <fixture-only: temporary Git repositories>
 *
 * TEMPORARY reproduction for @yrd/29648, captured as pre-change evidence per @chief.
 * Deleted before the commit: @cto's ruling makes the absent case uncompilable, so this
 * state cannot be pinned by a permanent test.
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
  const root = mkdtempSync(join(tmpdir(), "yrd-29648-"))
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

async function recordChange(repo: string, branch: string, tip: string, issue: string): Promise<void> {
  const git = gitIn(repo)
  const store = createEventStore(repo, "origin", git.selection)
  const queueTip = (await readEventQueue(store, "main")).tip
  if (queueTip === null) throw new Error("fixture queue has no tip")
  const at = new Date()
  const chain = await openEvents({ ...store, ref: changesRef("main", branch), writer: "fixture" })
  await chain.append(
    [
      changeInput("opened", { queueTip, at, commit: tip, by: "fixture", issue }),
      changeInput("merged", { queueTip, at, commit: tip }),
    ],
    { expect: null },
  )
}

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string }> {
  let stderr = ""
  return {
    io: { color: false, cwd, stderr: (text) => void (stderr += text), stdout: () => {} },
    stderr: () => stderr,
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

/** One merged root author, retired through the real entry; `io` decides what authority exists. */
async function retireWith(io: YrdCliIO, repo: string, branch: string) {
  const git = gitIn(repo)
  const target = (await git(["rev-parse", "origin/main"])).trim()
  const store = createEventStore(repo, "origin", git.selection)
  const { log } = collector()
  return retireMergedRootAuthor({
    repo,
    git,
    branch,
    change: await readStatus(store, "main", branch),
    base: target,
    store,
    queue: "main",
    target,
    io,
    log,
    actor: "fixture",
  })
}

/** A merged branch whose tip is an ancestor of origin/main, so retirement is eligible. */
async function mergedWorld(branch: string): Promise<{ repo: string; head: string }> {
  const repo = await world()
  const head = await branchFor(repo, branch, "opaque")
  await recordChange(repo, branch, head, "opaque")
  const git = gitIn(repo)
  await git(["merge", "--quiet", "--ff-only", branch])
  await git(["push", "--quiet", "origin", "main"])
  return { repo, head }
}

describe("29648 pre-change reproduction: absent authority is read as proof of no holds", () => {
  it("honours a hold when the reader is present", async () => {
    const branch = "task/29648-held"
    const { repo } = await mergedWorld(branch)
    const out = capture(repo)
    const result = await retireWith(
      { ...out.io, localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }) },
      repo,
      branch,
    )
    expect(result.outcome).toBe("kept")
    expect(result.detail).toContain("fixture hold")
  })

  it("removes when the reader is present and reports no holds", async () => {
    const branch = "task/29648-idle"
    const { repo, head } = await mergedWorld(branch)
    const out = capture(repo)
    const result = await retireWith(
      { ...out.io, localBranchProtections: async () => ({ protections: [], evidence: [] }) },
      repo,
      branch,
    )
    expect(result.outcome).toBe("removed")
    const git = gitIn(repo)
    expect((await git(["rev-parse", result.archiveRef])).trim()).toBe(head)
  })

  // THE DEFECT: no reader is wired at all, and retirement proceeds exactly as if a
  // reader had affirmed there are no holds. Nothing in the outcome, the archive or the
  // log distinguishes this run from the one above.
  it("removes when NO reader is wired at all, identically to a reader proving no holds", async () => {
    const branch = "task/29648-absent"
    const { repo, head } = await mergedWorld(branch)
    const out = capture(repo)
    expect(out.io.localBranchProtections).toBeUndefined()
    const result = await retireWith(out.io, repo, branch)
    expect(result.outcome).toBe("removed")
    const git = gitIn(repo)
    expect((await git(["rev-parse", result.archiveRef])).trim()).toBe(head)
    expect((await git(["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`])).trim()).toBe("")
  })
})
