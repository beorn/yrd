/**
 * @failure Closing an issue left its branches in place: `retireLocalBranch` had no caller on the close path,
 *          and `yrd drop --issue` kept a closed issue's never-submitted branch as `unreached`, so 91 branches
 *          sat on 64 closed issues (29450). A sweep that misread an unanswered resolver as "closed", deleted a
 *          tip nobody archived, or deleted a branch that moved after its archive would be worse than the gap.
 * @level   l2 (real bare remote, real event queue, real worktree holds)
 * @consumer the yrd service's round after a merge and hourly; the closer running `yrd drop --issue`
 * @testonly none
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  createEventQueue,
  createEventStore,
  listChanges,
  readConfig,
  type LocalBranchRetirement,
  type LogRecord,
} from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import {
  CLOSED_ISSUE_STATUSES,
  closedIssueSweepDue,
  markClosedIssueSweep,
  retireClosedIssueBranches,
} from "../src/branch-retirement.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { ResolvedIssue } from "../src/issue-resolver.ts"
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

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string; stdout(): string }> {
  let stderr = ""
  let stdout = ""
  return {
    io: { color: false, cwd, stderr: (text) => void (stderr += text), stdout: (text) => void (stdout += text) },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

/** Issue numbers → the status the declared resolver would answer; absent → `null` (no single bead bound). */
function resolverFor(statuses: Readonly<Record<string, string>>) {
  return async (raws: readonly string[]): Promise<readonly (ResolvedIssue | null)[]> =>
    raws.map((raw) => {
      const n = /(\d{5})/u.exec(raw)?.[1]
      const status = n === undefined ? undefined : statuses[n]
      return status === undefined ? null : { id: `@t/${n}-x`, status }
    })
}

const numberOf = (branch: string): string | undefined => /\/(\d{5})/u.exec(branch)?.[1]

function collector(): { rows: LogRecord[]; log: LocalBranchRetirement["log"] } {
  const rows: LogRecord[] = []
  return {
    rows,
    log: {
      write(record) {
        const row = { ...record, run: "test", at: new Date().toISOString() } as LogRecord
        rows.push(row)
        return row
      },
    },
  }
}

async function sweep(
  repo: string,
  statuses: Readonly<Record<string, string>>,
  options: Readonly<{
    io?: Partial<YrdCliIO>
    lookupMany?: ((raws: readonly string[]) => Promise<readonly (ResolvedIssue | null)[]>) | undefined
  }> = {},
) {
  const git = gitIn(repo)
  const out = capture(repo)
  const { rows, log } = collector()
  const target = (await git(["rev-parse", "origin/main"])).trim()
  const report = await retireClosedIssueBranches({
    repo,
    git,
    selection: git.selection,
    store: createEventStore(repo, "origin", git.selection),
    queue: "main",
    target,
    io: { ...out.io, ...options.io },
    log,
    actor: "yrd",
    branchIssue: (branch, recorded) => recorded ?? numberOf(branch),
    lookupMany: "lookupMany" in options ? options.lookupMany : resolverFor(statuses),
  })
  return { report, rows, stderr: out.stderr, git }
}

describe("29450 closing an issue retires its branches", () => {
  it("retires a closed issue's never-submitted branch: archived on origin, ended by a dropped event, removed, with its recovery command", async () => {
    const repo = await world()
    const tip = await branchFor(repo, "task/29100-never-submitted", "@t/29100-x")
    const { report, rows, git } = await sweep(repo, { "29100": "closed" })
    expect(report.resolverFailure).toBeUndefined()
    expect(report.kept).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.removed).toHaveLength(1)
    const row = report.removed[0]!
    expect(row).toMatchObject({
      branch: "task/29100-never-submitted",
      head: tip,
      issue: "@t/29100-x",
      status: "closed",
    })
    expect(row.archiveRef).toMatch(/^refs\/archive\/\d{4}-\d{2}-\d{2}\/yrd\/task\/29100-never-submitted$/u)
    // Origin holds the archive at the exact tip (the readback that gates the delete).
    expect((await git(["ls-remote", "origin", row.archiveRef!])).split("\t")[0]).toBe(tip)
    // The local ref is gone, the chain ended with a dropped event, and the row says how to bring it back.
    await expect(git(["rev-parse", "--verify", "--quiet", "refs/heads/task/29100-never-submitted"])).rejects.toThrow()
    const change = (await listChanges(createEventStore(repo, "origin", git.selection), "main")).get(
      "task/29100-never-submitted",
    )
    expect(change).toMatchObject({ status: "cancelled", reason: "dropped" })
    expect(row.recovery).toBe(`git -C ${repo} fetch origin ${row.archiveRef}:refs/heads/task/29100-never-submitted`)
    const receipt = rows.find((r) => r.kind === "closed-issue-retirement" && r.branch === "task/29100-never-submitted")
    expect(receipt).toMatchObject({
      outcome: "removed",
      issue: "@t/29100-x",
      status: "closed",
      archive: row.archiveRef,
    })
    expect(receipt?.recovery).toBe(row.recovery)
    expect(rows.find((r) => r.kind === "closed-issue-retirement" && r.scope === "summary")).toMatchObject({
      examined: 1,
      closedIssues: 1,
      removed: 1,
      kept: 0,
      failed: 0,
    })
  })

  it("retires a closed issue's merged branch as landed, and a dropped issue's branch like a closed one", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const merged = await branchFor(repo, "task/29101-merged", "@t/29101-x")
    await git(["push", "--quiet", "origin", `${merged}:refs/heads/main`])
    await git(["fetch", "--quiet", "origin", "main"])
    const dropped = await branchFor(repo, "task/29102-dropped-issue", "@t/29102-x")
    const { report } = await sweep(repo, { "29101": "closed", "29102": "dropped" })
    expect(report.failed).toEqual([])
    expect(report.kept).toEqual([])
    expect(report.removed.map((row) => [row.branch, row.reason])).toEqual(
      expect.arrayContaining([
        ["task/29101-merged", "landed by ancestry"],
        ["task/29102-dropped-issue", "closed issue"],
      ]),
    )
    // A merged tip's custody is main: the archive is local only and no recovery command is offered.
    const landed = report.removed.find((row) => row.branch === "task/29101-merged")!
    expect(landed.recovery).toBeUndefined()
    expect((await git(["rev-parse", landed.archiveRef!])).trim()).toBe(merged)
    expect(await git(["ls-remote", "origin", landed.archiveRef!])).toBe("")
    const ended = report.removed.find((row) => row.branch === "task/29102-dropped-issue")!
    expect(ended.status).toBe("dropped")
    expect(landed.status).toBe("closed")
    expect((await git(["ls-remote", "origin", ended.archiveRef!])).split("\t")[0]).toBe(dropped)
    expect(report.closedIssues).toBe(2)
  })

  it("keeps an open issue's branch untouched, keeps a worktree-held branch naming its path, and keeps an open change as active", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const open = await branchFor(repo, "task/29103-open-issue", "@t/29103-x")
    const held = await branchFor(repo, "task/29104-held", "@t/29104-x")
    const hold = join(repo, "..", "hold-29104")
    await git(["worktree", "add", "--quiet", hold, "task/29104-held"])
    await branchFor(repo, "task/29105-submitted", "@t/29105-x")
    await git(["checkout", "--quiet", "task/29105-submitted"])
    const submitted = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "submit", "--submitter", "fixture", "--json"], submitted.io),
      submitted.stderr(),
    ).toBe(0)
    await git(["checkout", "--quiet", "main"])
    const { report } = await sweep(repo, { "29103": "in_progress", "29104": "closed", "29105": "closed" })
    expect(report.removed).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.openIssues).toBe(1)
    expect((await git(["rev-parse", "refs/heads/task/29103-open-issue"])).trim()).toBe(open)
    const heldRow = report.kept.find((row) => row.branch === "task/29104-held")!
    expect(heldRow.outcome).toBe("kept")
    expect(heldRow.detail).toContain("checked out at")
    expect((await git(["rev-parse", "refs/heads/task/29104-held"])).trim()).toBe(held)
    expect(report.kept.find((row) => row.branch === "task/29105-submitted")).toMatchObject({
      reason: "active",
      detail: expect.stringContaining("change is "),
    })
  })

  it("keeps and names a branch that moves between its archive and its delete", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const tip = await branchFor(repo, "task/29106-moves", "@t/29106-x")
    await git(["checkout", "--quiet", "task/29106-moves"])
    await git(["commit", "--quiet", "--allow-empty", "-m", "the move the sweep must notice"])
    const moved = (await git(["rev-parse", "HEAD"])).trim()
    await git(["reset", "--quiet", "--hard", tip])
    await git(["checkout", "--quiet", "main"])
    let reads = 0
    const { report } = await sweep(
      repo,
      { "29106": "closed" },
      {
        io: {
          localBranchProtections: async ({ branch }) => {
            // The second protection read is the one immediately before the conditional delete.
            if (branch === "task/29106-moves" && ++reads === 2) {
              await git(["update-ref", "refs/heads/task/29106-moves", moved])
            }
            return []
          },
        },
      },
    )
    expect(report.removed).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.kept).toHaveLength(1)
    expect(report.kept[0]).toMatchObject({ branch: "task/29106-moves", head: tip })
    expect(report.kept[0]!.reason).toContain("branch moved")
    expect(report.kept[0]!.reason).toContain(moved)
    expect((await git(["rev-parse", "refs/heads/task/29106-moves"])).trim()).toBe(moved)
    expect(reads).toBeGreaterThanOrEqual(2)
  })

  it("keeps every branch and names the failure when the resolver fails or answers no bound bead", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const tip = await branchFor(repo, "task/29107-resolver-down", "@t/29107-x")
    const failing = await sweep(
      repo,
      {},
      {
        lookupMany: async () => {
          throw new Error("target .yrd.yml issueResolver failed: exit 81")
        },
      },
    )
    expect(failing.report.resolverFailure).toContain("exit 81")
    expect(failing.report.removed).toEqual([])
    expect(failing.report.kept).toEqual([])
    expect(failing.stderr()).toContain("resolver failed, every branch kept")
    expect(failing.rows.find((r) => r.kind === "closed-issue-retirement" && r.scope === "summary")).toMatchObject({
      resolverFailure: expect.stringContaining("exit 81"),
      removed: 0,
    })
    expect((await git(["rev-parse", "refs/heads/task/29107-resolver-down"])).trim()).toBe(tip)
    // No bound bead for the reference: unknown, never closed.
    const unknown = await sweep(repo, {})
    expect(unknown.report.unknownIssues).toBe(1)
    expect(unknown.report.removed).toEqual([])
    expect((await git(["rev-parse", "refs/heads/task/29107-resolver-down"])).trim()).toBe(tip)
    // No declared resolver at all: the same, named.
    const undeclared = await sweep(repo, {}, { lookupMany: undefined })
    expect(undeclared.report.resolverFailure).toContain("no issueResolver")
    expect((await git(["rev-parse", "refs/heads/task/29107-resolver-down"])).trim()).toBe(tip)
  })

  it("sweeps at service start, after a merged round, and hourly, counting time rather than rounds", () => {
    const repo = `/fixture/${Math.random().toString(36).slice(2)}`
    const t0 = 1_700_000_000_000
    expect(closedIssueSweepDue({ repo, merged: 0, now: t0 })).toBe(true)
    markClosedIssueSweep(repo, t0)
    expect(closedIssueSweepDue({ repo, merged: 0, now: t0 + 15_000 })).toBe(false)
    expect(closedIssueSweepDue({ repo, merged: 1, now: t0 + 15_000 })).toBe(true)
    expect(closedIssueSweepDue({ repo, merged: 0, now: t0 + 3_599_999 })).toBe(false)
    expect(closedIssueSweepDue({ repo, merged: 0, now: t0 + 3_600_000 })).toBe(true)
    expect([...CLOSED_ISSUE_STATUSES].sort()).toEqual(["closed", "dropped"])
  })

  it("yrd drop --issue on a closed issue retires its never-submitted branch through the closed disposition", async () => {
    const resolver = ["sh", "-c", 'printf \'{"id":"@t/29108-x","status":"closed"}\\n\'', "resolver"]
    const repo = await world(`issueResolver: ${JSON.stringify(resolver)}\n`)
    const git = gitIn(repo)
    const tip = await branchFor(repo, "task/29108-local-only", "@t/29108-x")
    const output = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "drop", "--issue", "@t/29108-x", "--submitter", "fixture", "--json"],
        output.io,
      ),
      output.stderr(),
    ).toBe(0)
    const report = JSON.parse(output.stdout()) as {
      removed: { branch: string; head: string; reason: string; archiveRef: string; recovery?: string }[]
      kept: { branch: string; reason: string }[]
    }
    expect(report.kept).toEqual([])
    expect(report.removed).toEqual([
      expect.objectContaining({ branch: "task/29108-local-only", head: tip, reason: "closed" }),
    ])
    const row = report.removed[0]!
    expect((await git(["ls-remote", "origin", row.archiveRef])).split("\t")[0]).toBe(tip)
    expect(row.recovery).toContain(`${row.archiveRef}:refs/heads/task/29108-local-only`)
    await expect(git(["rev-parse", "--verify", "--quiet", "refs/heads/task/29108-local-only"])).rejects.toThrow()
  })
})
