/**
 * @failure Closing an issue left its branches in place: `retireLocalBranch` had no caller on the close path,
 *          and `yrd drop --issue` kept a closed issue's never-submitted branch as `unreached`, so 91 branches
 *          sat on 64 closed issues (29450). A sweep that misread an unanswered resolver as "closed", judged with
 *          no protections reader, deleted a tip nobody archived, ended a MERGED change with a dropped event,
 *          deleted a branch that moved after its archive, or bound a branch by its name alone would be worse
 *          than the gap (@cto dd209c0b, b023d5e2, bbec7bb5; work.md:94, :99).
 * @level   l2 (real bare remote, real event queue, real worktree holds)
 * @consumer the yrd service's round after a merge and hourly; the closer running `yrd drop --issue`
 * @testonly none
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
  listChanges,
  readConfig,
  readEventQueue,
  type LocalBranchRetirement,
  type LogRecord,
} from "@yrd/queue-core"
import { openEvents } from "gitomic/events"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import {
  CLOSED_ISSUE_STATUSES,
  closedIssueSweepDue,
  markClosedIssueSweep,
  retireClosedIssueBranches,
} from "../src/branch-retirement.ts"
import { runYrdProcess } from "../src/cli.ts"
import { issueLookupMany, type ResolvedIssue } from "../src/issue-resolver.ts"
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
  issue: string,
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
    // The host's protections reader is present by default; one row removes it on purpose.
    io: { ...out.io, localBranchProtections: async () => [], ...options.io },
    log,
    actor: "yrd",
    nameNumber: numberOf,
    lookupMany: "lookupMany" in options ? options.lookupMany : resolverFor(statuses),
  })
  return { report, rows, stderr: out.stderr, git, target }
}

describe("29450 closing an issue retires its branches", () => {
  it("retires a closed issue's withdrawn change: archived on origin, ended by a dropped event, removed, with its recovery command", async () => {
    const repo = await world()
    const tip = await branchFor(repo, "task/29100-withdrawn", "@t/29100-x")
    await recordChange(repo, "task/29100-withdrawn", tip, "@t/29100-x", "withdrawn")
    const { report, rows, git, target } = await sweep(repo, { "29100": "closed" })
    expect(report.everyBranchKept).toBeUndefined()
    expect(report.kept).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.removed).toHaveLength(1)
    const row = report.removed[0]!
    expect(row).toMatchObject({
      branch: "task/29100-withdrawn",
      head: tip,
      issue: "@t/29100-x",
      status: "closed",
      custody: "origin",
    })
    expect(row.archiveRef).toMatch(/^refs\/archive\/\d{4}-\d{2}-\d{2}\/yrd\/task\/29100-withdrawn$/u)
    // Origin holds the archive at the exact tip (the readback that gates the delete).
    expect((await git(["ls-remote", "origin", row.archiveRef!])).split("\t")[0]).toBe(tip)
    // The local ref is gone, the chain ended with a dropped event, and the row says how to bring it back.
    await expect(git(["rev-parse", "--verify", "--quiet", "refs/heads/task/29100-withdrawn"])).rejects.toThrow()
    const change = (await listChanges(createEventStore(repo, "origin", git.selection), "main")).get(
      "task/29100-withdrawn",
    )
    expect(change).toMatchObject({ status: "cancelled", reason: "dropped" })
    expect(row.recovery).toBe(`git -C ${repo} fetch origin ${row.archiveRef}:refs/heads/task/29100-withdrawn`)
    const receipt = rows.find((r) => r.kind === "closed-issue-retirement" && r.branch === "task/29100-withdrawn")
    expect(receipt).toMatchObject({
      outcome: "removed",
      issue: "@t/29100-x",
      status: "closed",
      archive: row.archiveRef,
      custody: "origin",
    })
    expect(receipt?.recovery).toBe(row.recovery)
    expect(rows.find((r) => r.kind === "closed-issue-retirement" && r.scope === "summary")).toMatchObject({
      repo,
      target,
      examined: 1,
      boundByNameOnly: 0,
      closedIssues: 1,
      removed: 1,
      kept: 0,
      failed: 0,
    })
  })

  it("retires a merged branch by main custody, and a merged change whose tip is not on main by its recorded landing: never a dropped event", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const onMain = await branchFor(repo, "task/29101-merged", "@t/29101-x")
    await recordChange(repo, "task/29101-merged", onMain, "@t/29101-x", "merged")
    await git(["push", "--quiet", "origin", `${onMain}:refs/heads/main`])
    await git(["fetch", "--quiet", "origin", "main"])
    // The queue rebuilt this one: its change is merged, its own tip is not an ancestor of main (@cto b023d5e2 blocking 2).
    const rebuilt = await branchFor(repo, "task/29109-rebuilt", "@t/29109-x")
    await recordChange(repo, "task/29109-rebuilt", rebuilt, "@t/29109-x", "merged")
    const { report, git: g } = await sweep(repo, { "29101": "closed", "29109": "closed" })
    expect(report.failed).toEqual([])
    expect(report.kept).toEqual([])
    const landed = report.removed.find((row) => row.branch === "task/29101-merged")!
    expect(landed).toMatchObject({ reason: "landed by ancestry", custody: "main", status: "closed" })
    expect(landed.recovery).toBeUndefined()
    expect((await g(["rev-parse", landed.archiveRef!])).trim()).toBe(onMain)
    expect(await g(["ls-remote", "origin", landed.archiveRef!])).toBe("")
    const byLanding = report.removed.find((row) => row.branch === "task/29109-rebuilt")!
    expect(byLanding).toMatchObject({ reason: "landed by landing", custody: "landing", status: "closed" })
    expect(byLanding.recovery).toBeUndefined()
    expect((await g(["rev-parse", byLanding.archiveRef!])).trim()).toBe(rebuilt)
    expect(await g(["ls-remote", "origin", byLanding.archiveRef!])).toBe("")
    await expect(g(["rev-parse", "--verify", "--quiet", "refs/heads/task/29109-rebuilt"])).rejects.toThrow()
    // The chain still reads merged: no dropped event was appended.
    const change = (await listChanges(createEventStore(repo, "origin", g.selection), "main")).get("task/29109-rebuilt")
    expect(change).toMatchObject({ status: "merged" })
    expect(report.closedIssues).toBe(2)
  })

  it("a dropped issue takes the closed path like a closed one", async () => {
    const repo = await world()
    const tip = await branchFor(repo, "task/29102-dropped-issue", "@t/29102-x")
    await recordChange(repo, "task/29102-dropped-issue", tip, "@t/29102-x", "withdrawn")
    const { report, git } = await sweep(repo, { "29102": "dropped" })
    expect(report.kept).toEqual([])
    expect(report.removed).toHaveLength(1)
    expect(report.removed[0]).toMatchObject({
      branch: "task/29102-dropped-issue",
      status: "dropped",
      custody: "origin",
    })
    expect((await git(["ls-remote", "origin", report.removed[0]!.archiveRef!])).split("\t")[0]).toBe(tip)
  })

  it("keeps an open issue's branch untouched, keeps a worktree-held branch naming its path, and keeps an open change as active", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const open = await branchFor(repo, "task/29103-open-issue", "@t/29103-x")
    await recordChange(repo, "task/29103-open-issue", open, "@t/29103-x", "merged")
    const held = await branchFor(repo, "task/29104-held", "@t/29104-x")
    await recordChange(repo, "task/29104-held", held, "@t/29104-x", "merged")
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

  it("keeps and lists a branch that binds by its name alone, even on a closed issue (work.md:99)", async () => {
    const repo = await world()
    const tip = await branchFor(repo, "task/29100-never-submitted", "@t/29100-x")
    const { report, rows, git } = await sweep(repo, { "29100": "closed" })
    expect(report.removed).toEqual([])
    expect(report.boundByNameOnly).toBe(1)
    expect(report.closedIssues).toBe(0)
    expect(report.kept).toEqual([
      expect.objectContaining({
        branch: "task/29100-never-submitted",
        head: tip,
        reason: "bound by name only",
        detail: expect.stringContaining("29100"),
      }),
    ])
    expect((await git(["rev-parse", "refs/heads/task/29100-never-submitted"])).trim()).toBe(tip)
    expect(rows.find((r) => r.kind === "closed-issue-retirement" && r.scope === "summary")).toMatchObject({
      boundByNameOnly: 1,
      removed: 0,
      kept: 1,
    })
  })

  it("keeps and names a branch whose event history is unreadable: a diagnostic on its change, or an invalid chain (review2 ee911aeb)", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const queueTip = (await readEventQueue(store, "main")).tip
    if (queueTip === null) throw new Error("fixture queue has no tip")
    const at = new Date()
    // A merged change followed by an event this reader cannot fold: the fold keeps the merged state and names the
    // event in `diagnostic`. Without the boundary the sweep retired this tip as landed by its recorded landing.
    const diagnosed = await branchFor(repo, "task/29120-diagnosed", "@t/29120-x")
    const diagnosedChain = await openEvents({
      ...store,
      ref: changesRef("main", "task/29120-diagnosed"),
      writer: "fixture",
    })
    await diagnosedChain.append(
      [
        changeInput("opened", { queueTip, at, commit: diagnosed, by: "fixture", issue: "@t/29120-x" }),
        changeInput("merged", { queueTip, at, commit: diagnosed }),
        { type: "future-unreadable-state", title: "future event", content: "", props: [] },
      ],
      { expect: null },
    )
    // A chain whose first event lacks what an `opened` event must carry: the projection refuses it as invalid.
    const broken = await branchFor(repo, "task/29121-broken", "@t/29121-x")
    const brokenChain = await openEvents({ ...store, ref: changesRef("main", "task/29121-broken"), writer: "fixture" })
    await brokenChain.append([{ type: "opened", title: "opened", content: "", props: [] }], { expect: null })

    const { report, rows } = await sweep(repo, { "29120": "closed", "29121": "closed" })
    expect(report.removed).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.kept).toEqual([
      expect.objectContaining({
        branch: "task/29120-diagnosed",
        head: diagnosed,
        reason: "unreadable",
        detail: expect.stringContaining("future-unreadable-state"),
      }),
      expect.objectContaining({
        branch: "task/29121-broken",
        head: broken,
        reason: "unreadable",
        detail: expect.stringContaining(changesRef("main", "task/29121-broken")),
      }),
    ])
    expect((await git(["rev-parse", "refs/heads/task/29120-diagnosed"])).trim()).toBe(diagnosed)
    expect((await git(["rev-parse", "refs/heads/task/29121-broken"])).trim()).toBe(broken)
    expect(
      rows.filter((r) => r.kind === "closed-issue-retirement" && r.scope !== "summary").map((r) => r.reason),
    ).toEqual(["unreadable", "unreadable"])
    expect(rows.find((r) => r.kind === "closed-issue-retirement" && r.scope === "summary")).toMatchObject({
      removed: 0,
      kept: 2,
    })
  })

  it("keeps a merged change whose tip moved past its landing: never the closed disposition, never a second ending (@cto 9a68f296)", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const landed = await branchFor(repo, "task/29122-moved", "@t/29122-x")
    await recordChange(repo, "task/29122-moved", landed, "@t/29122-x", "merged")
    // One more commit on the branch after its landing was recorded: no landing pin matches the tip, no ancestry.
    await git(["checkout", "--quiet", "task/29122-moved"])
    writeFileSync(join(repo, "after-the-landing.txt"), "after\n")
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", "after the landing"])
    const moved = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    const { report, git: g } = await sweep(repo, { "29122": "closed" })
    expect(report.removed).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.kept).toEqual([
      expect.objectContaining({
        branch: "task/29122-moved",
        head: moved,
        reason: `merged at ${landed}; tip has commits past the landing`,
      }),
    ])
    expect((await g(["rev-parse", "refs/heads/task/29122-moved"])).trim()).toBe(moved)
    expect(await g(["ls-remote", "origin", "refs/archive/*"]), "nothing was archived").toBe("")
    // The chain still ends merged: no dropped event was appended.
    const change = (await listChanges(createEventStore(repo, "origin", g.selection), "main")).get("task/29122-moved")
    expect(change).toMatchObject({ status: "merged" })
  })

  it("keeps and names a branch that moves between its archive and its delete", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const tip = await branchFor(repo, "task/29106-moves", "@t/29106-x")
    await recordChange(repo, "task/29106-moves", tip, "@t/29106-x", "withdrawn")
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

  it("judges nothing and names it when the host's protections reader is absent", async () => {
    const repo = await world()
    const tip = await branchFor(repo, "task/29110-unprotected", "@t/29110-x")
    await recordChange(repo, "task/29110-unprotected", tip, "@t/29110-x", "withdrawn")
    const { report, rows, stderr, git } = await sweep(
      repo,
      { "29110": "closed" },
      { io: { localBranchProtections: undefined } },
    )
    expect(report.everyBranchKept).toContain("no localBranchProtections reader")
    expect(report.removed).toEqual([])
    expect(report.kept).toEqual([])
    expect(stderr()).toContain("every branch kept: no localBranchProtections reader")
    expect(rows.find((r) => r.kind === "closed-issue-retirement" && r.scope === "summary")).toMatchObject({
      everyBranchKept: expect.stringContaining("localBranchProtections"),
      removed: 0,
    })
    expect((await git(["rev-parse", "refs/heads/task/29110-unprotected"])).trim()).toBe(tip)
  })

  it("keeps every branch and names the failure when the resolver fails, answers no bound bead, or is undeclared", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const tip = await branchFor(repo, "task/29107-resolver-down", "@t/29107-x")
    await recordChange(repo, "task/29107-resolver-down", tip, "@t/29107-x", "withdrawn")
    const failing = await sweep(
      repo,
      {},
      {
        lookupMany: async () => {
          throw new Error("target .yrd.yml issueResolver failed: exit 81")
        },
      },
    )
    expect(failing.report.everyBranchKept).toContain("exit 81")
    expect(failing.report.removed).toEqual([])
    expect(failing.report.kept).toEqual([])
    expect(failing.stderr()).toContain("every branch kept: resolver failed")
    expect(failing.rows.find((r) => r.kind === "closed-issue-retirement" && r.scope === "summary")).toMatchObject({
      everyBranchKept: expect.stringContaining("exit 81"),
      removed: 0,
    })
    expect((await git(["rev-parse", "refs/heads/task/29107-resolver-down"])).trim()).toBe(tip)
    // No bound bead for the reference: unknown, never closed — and a row of its own.
    const unknown = await sweep(repo, {})
    expect(unknown.report.unknownIssues).toBe(1)
    expect(unknown.report.removed).toEqual([])
    expect(unknown.report.kept).toEqual([
      expect.objectContaining({
        branch: "task/29107-resolver-down",
        reason: "unknown issue",
        detail: expect.stringContaining("@t/29107-x"),
      }),
    ])
    expect((await git(["rev-parse", "refs/heads/task/29107-resolver-down"])).trim()).toBe(tip)
    // No declared resolver at all: the same, named.
    const undeclared = await sweep(repo, {}, { lookupMany: undefined })
    expect(undeclared.report.everyBranchKept).toContain("no issueResolver")
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

  it("issueLookupMany takes one object for one reference and an array for several, and refuses any other shape by name", async () => {
    const script =
      'if [ "$#" -gt 1 ]; then printf "["; sep=""; for r in "$@"; do printf "%s{\\"id\\":\\"@t/%s-x\\",\\"status\\":\\"closed\\"}" "$sep" "$r"; sep=","; done; printf "]"; else printf "{\\"id\\":\\"@t/%s-x\\",\\"status\\":\\"closed\\"}" "$1"; fi'
    const repo = await world(`issueResolver: ${JSON.stringify(["sh", "-c", script, "resolver"])}\n`)
    const git = gitIn(repo)
    const config = await readConfig(git, (await git(["rev-parse", "HEAD"])).trim(), {
      branch: "main",
      remote: "origin",
    })
    if (config === undefined) throw new Error("fixture lost .yrd.yml")
    const lookup = issueLookupMany(config, repo)
    if (lookup === undefined) throw new Error("fixture lost the resolver")
    expect(await lookup(["29111"])).toEqual([{ id: "@t/29111-x", status: "closed" }])
    expect(await lookup(["29111", "29112"])).toEqual([
      { id: "@t/29111-x", status: "closed" },
      { id: "@t/29112-x", status: "closed" },
    ])
    const odd = await world(
      `issueResolver: ${JSON.stringify(["sh", "-c", 'printf \'{"id":"@t/1-x"}\'', "resolver"])}\n`,
    )
    const oddGit = gitIn(odd)
    const oddConfig = await readConfig(oddGit, (await oddGit(["rev-parse", "HEAD"])).trim(), {
      branch: "main",
      remote: "origin",
    })
    const oddLookup = issueLookupMany(oddConfig!, odd)!
    await expect(oddLookup(["29111", "29112"])).rejects.toThrow(
      /answered 2 issue references with a object; expected one object or null per reference/u,
    )
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
