/**
 * @failure `yrd pr list` silently drops rows it selected, hides its own window with no count of what it withheld, or labels a change whose head is already on the base branch as if its content never merged (22376).
 * @level l2
 * @consumer @yrd/cli pr list
 *
 * Two live specimens from 2026-07-25, both on the change-state surface, both
 * answering "what is outstanding?" with something false in opposite
 * directions: the first hid live work, the second hid merged work.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint, type Change } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withContests, type CommitResolver } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import {
  withMerge,
  withQueue,
  withStep,
  type ChangeEligibility,
  type ChangeShape,
  type SourceRewrite,
  type StepExecution,
} from "@yrd/queue"
import { runYrd, type PruneGitFacts, type YrdCliIO } from "@yrd/cli"
import { createLogger } from "loggily"
import { createPruneGitFacts } from "../src/pr-withdraw.ts"
import { changeListRows, ChangeListView, type ChangeListRow } from "../src/queue-status-view.tsx"

const WIDTH = 120
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)
const MERGED_HEAD = "c".repeat(40)
const LIVE_HEAD = "d".repeat(40)

// ---------------------------------------------------------------------------
// Specimen 1 — the view must render every row it was handed.

function row(id: number, overrides: Partial<ChangeListRow> = {}): ChangeListRow {
  return {
    pr: `PR${id}`,
    state: "integrated",
    stateLabel: "✓ integrated",
    glyph: "✓",
    revision: 1,
    lineage: "1",
    subject: `subject ${id}`,
    submitter: "@ci",
    target: "main",
    review: "n/a",
    checks: "pass",
    why: "terminal",
    age: "1m",
    touched: "1h",
    ...overrides,
  }
}

async function renderRows(rows: readonly ChangeListRow[]): Promise<string> {
  return renderString(createElement(ChangeListView, { rows, columns: WIDTH }), {
    width: WIDTH,
    height: 10_000,
    plain: true,
  })
}

function renderedIds(output: string): number[] {
  return [...output.matchAll(/pr#(\d+)\./gu)].map(([, id]) => Number(id))
}

describe("pr list row losslessness (22376)", () => {
  it("renders every row when no cell wraps", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(1642 + index))
    expect(renderedIds(await renderRows(rows))).toEqual(rows.map((_, index) => 1642 + index))
  })

  /**
   * The live specimen: `pr list` ended at pr#1659 while PR1660 and PR1661 were
   * both alive, and `pr view PR1661` showed it submitted at queue position 3.
   * The two rows that vanished were the two NEWEST — the ones an operator has
   * just created and is least likely to doubt.
   *
   * The mechanism is a wrapped cell. Two rows in the window carried the
   * `already-landed` state, whose label is one cell wider than the STATE column
   * allows, so each consumed two physical lines inside a viewport sized to the
   * ROW count. Every wrapped cell therefore evicts one row off the bottom, in
   * silence.
   */
  it("renders every row when a state label overflows its column", async () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      index === 2 || index === 5
        ? row(1642 + index, { state: "already-landed", stateLabel: "✓ already-landed" })
        : row(1642 + index),
    )
    expect(renderedIds(await renderRows(rows))).toEqual(rows.map((_, index) => 1642 + index))
  })

  it("keeps one physical line per row so a long subject cannot evict its neighbours", async () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      index === 3
        ? row(200 + index, { subject: "fix(yrd): ".padEnd(300, "x"), why: "checks-pending-on-a-very-long-code" })
        : row(200 + index),
    )
    const output = await renderRows(rows)
    expect(renderedIds(output)).toEqual(rows.map((_, index) => 200 + index))
    expect(output.split("\n").filter((line) => line.trim() !== "")).toHaveLength(rows.length + 1)
  })
})

// ---------------------------------------------------------------------------
// Command surface — the real `yrd pr list` through runYrd.

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "pr-list-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: LIVE_HEAD, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: LIVE_HEAD, baseSha: BASE_SHA, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: LIVE_HEAD, pushed: true as const, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  }
}

async function createCliApp() {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
  const merge = withMerge(
    async (
      _input: StepExecution<ChangeShape>,
    ): Promise<JobResult<{ commit: string; baseSha: string; sourceRewrites?: readonly SourceRewrite[] }>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({ steps: [check, merge] as const, batch: false })
  const git: CommitResolver = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  const contests = withContests({ runners: [], evaluators: [], git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      prNumberMint: volatilePrNumberMint(),
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-07-15T12:00:00.000Z",
      id: ids(),
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type CliApp = Awaited<ReturnType<typeof createCliApp>>

function outputIO(overrides: Partial<YrdCliIO> = {}) {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    cwd: "/repo",
    columns: WIDTH,
    runner: "pr-list-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-15T12:01:00.000Z"),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

/** Git facts that place LANDED_HEAD on the base tip and keep LIVE_HEAD off it.
 * Every other capability refuses so a test proves exactly which plumbing the
 * list consulted. */
function mergeGit(overrides: Partial<PruneGitFacts> = {}): PruneGitFacts {
  return {
    resolveCommit: (ref) =>
      ref === "origin/main" || ref === "main" ? BASE_SHA : ref === MERGED_HEAD || ref === LIVE_HEAD ? ref : undefined,
    isAncestor: (ancestor, descendant) => ancestor === MERGED_HEAD && descendant === BASE_SHA,
    mergeTree: () => {
      throw new Error("pr list must not need a merge-tree proof")
    },
    treeOf: () => {
      throw new Error("pr list must not need a tree OID")
    },
    ...overrides,
  }
}

describe("pr list bounded-window disclosure (22376)", () => {
  it("names how many rows the default window withheld", async () => {
    const app = await createCliApp()
    for (const index of Array.from({ length: 26 }, (_, offset) => offset + 1)) {
      await app.bays.submit({
        branch: `topic/window-${index}`,
        headSha: index.toString(16).padStart(40, "0"),
        base: "main",
        baseSha: BASE_SHA,
      })
    }
    // The six oldest go terminal: open PRs are never windowed out (see
    // live-work-visibility.test.ts), so only terminal rows exercise the cut.
    for (const index of Array.from({ length: 6 }, (_, offset) => offset + 1)) {
      await app.bays.closePr({ pr: `PR${index}`, reason: "window specimen" })
    }

    const human = outputIO()
    expect(await runYrd(app as CliApp, yrd("pr", "list"), human.io), human.stderr()).toBe(0)
    const output = human.stdout()

    // Every windowed row is present…
    expect(renderedIds(output)).toEqual(Array.from({ length: 20 }, (_, offset) => 7 + offset))
    // …and the six it withheld are stated, not silent.
    expect(output).toMatch(/\b6\b[^\n]*hidden/iu)
    expect(output).toContain("--json")
  })

  it("says nothing about a window it did not apply", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: LIVE_HEAD, base: "main", baseSha: BASE_SHA })
    const human = outputIO()
    expect(await runYrd(app as CliApp, yrd("pr", "list"), human.io), human.stderr()).toBe(0)
    expect(human.stdout()).not.toMatch(/hidden/iu)
  })
})

describe("pr list merge reconciliation (22376)", () => {
  /**
   * The live specimen: `pr list` reported `pr#1658.5 − withdrawn` while
   * `git merge-base --is-ancestor 5ac4f5a219dc origin/main` said MERGED — the
   * habitant runner had merged rev5 an hour earlier and the author's withdrawal
   * arrived on top of the completed merge. An author who trusts `withdrawn`
   * re-cuts a branch already on main, and duplicate merges of the same
   * content are exactly what the ancestry model cannot clean up afterwards.
   */
  it("reports the merge when a withdrawal arrives on top of it", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/merged", headSha: MERGED_HEAD, base: "main", baseSha: BASE_SHA })
    await app.bays.closePr({ pr: "PR1", reason: "author changed their mind" })

    const json = outputIO({ pruneGit: () => mergeGit() })
    expect(await runYrd(app as CliApp, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
    const listed = JSON.parse(json.stdout()) as {
      prs: readonly Readonly<{ id: string; status: string; nativeStatus?: string }>[]
    }
    expect(listed.prs).toHaveLength(1)
    expect(listed.prs[0]).toMatchObject({
      id: "PR1",
      status: "already-landed",
      nativeStatus: "withdrawn",
    })

    const human = outputIO({ pruneGit: () => mergeGit(), columns: 200 })
    expect(await runYrd(app as CliApp, yrd("pr", "list"), human.io), human.stderr()).toBe(0)
    expect(human.stdout()).toContain("already-landed")
    expect(human.stdout()).toContain("withdrawn-after-landing")
  })

  it("leaves a withdrawal whose content is not on the base alone", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/live", headSha: LIVE_HEAD, base: "main", baseSha: BASE_SHA })
    await app.bays.closePr({ pr: "PR1", reason: "superseded by a different design" })

    const json = outputIO({ pruneGit: () => mergeGit() })
    expect(await runYrd(app as CliApp, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
    const listed = JSON.parse(json.stdout()) as { prs: readonly Readonly<{ id: string; status: string }>[] }
    expect(listed.prs[0]).toMatchObject({ id: "PR1", status: "withdrawn" })
  })

  /** The fake above proves the projection; this proves the plumbing under it —
   * real Git, one batched answer, against a merged head, an unmerged head, and
   * a head this repository has never seen. */
  it("answers merged / unmerged / absent from one real batched Git query", () => {
    const dir = mkdtempSync(join(tmpdir(), "yrd-pr-list-merge-"))
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()
    try {
      git("init", "-q", "-b", "main")
      git("config", "user.name", "Yrd Test")
      git("config", "user.email", "yrd@example.invalid")
      writeFileSync(join(dir, "base.md"), "base\n")
      git("add", ".")
      git("commit", "-qm", "base")

      git("switch", "-q", "-c", "topic/merged")
      writeFileSync(join(dir, "merged.md"), "merged\n")
      git("add", ".")
      git("commit", "-qm", "landed")
      const mergedHead = git("rev-parse", "HEAD")

      git("switch", "-q", "-c", "topic/live", "main")
      writeFileSync(join(dir, "live.md"), "live\n")
      git("add", ".")
      git("commit", "-qm", "live")
      const liveHead = git("rev-parse", "HEAD")

      git("switch", "-q", "main")
      git("merge", "-q", "--no-ff", "-m", "merge merged", mergedHead)
      const baseSha = git("rev-parse", "HEAD")

      const facts = createPruneGitFacts(dir)
      const absent = "9".repeat(40)
      expect(facts.mergedOnBase?.(baseSha, [mergedHead, liveHead, absent])).toEqual([mergedHead])
      // The fallback path every implementation without the batch fact takes
      // must reach the same verdict, or the two rails could disagree silently.
      expect(facts.isAncestor(mergedHead, baseSha)).toBe(true)
      expect(facts.isAncestor(liveHead, baseSha)).toBe(false)
      expect(facts.resolveCommit(absent)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("never probes git for a change whose recorded state already claims a merge", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/live", headSha: LIVE_HEAD, base: "main", baseSha: BASE_SHA })

    const json = outputIO({
      pruneGit: () => ({
        ...mergeGit(),
        resolveCommit: () => {
          throw new Error("a live change needs no ancestry proof")
        },
        isAncestor: () => {
          throw new Error("a live change needs no ancestry proof")
        },
      }),
    })
    expect(await runYrd(app as CliApp, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
    expect((JSON.parse(json.stdout()) as { prs: readonly Readonly<{ status: string }>[] }).prs[0]).toMatchObject({
      status: "submitted",
    })
  })
})

// ---------------------------------------------------------------------------
// WHY carries its human message on the row alongside the code token.

describe("pr list WHY reason message", () => {
  function blockedChange(): Change {
    return {
      id: "PR9",
      name: "Blocked change",
      branch: "topic/blocked",
      base: "main",
      state: "open",
      merged: false,
      revs: [
        {
          n: 1,
          head: LIVE_HEAD,
          base: "main",
          baseSha: BASE_SHA,
          pushedAt: "2026-07-15T11:00:00.000Z",
          submittedAt: "2026-07-15T11:00:00.000Z",
          submitter: "author@example.test",
        },
      ],
      reviews: [],
      comments: [],
      checkRequests: [],
    }
  }

  it("the WHY code carries its message on the row, and the code token itself is unchanged", () => {
    const message = "change 'PR9' review was rejected by @reviewer"
    const eligibility: ChangeEligibility = {
      pr: "PR9",
      revision: 1,
      runnable: false,
      reason: { code: "review-rejected", message },
      review: { required: true, approved: false, stale: false, decision: "reject", by: "@reviewer" },
      checks: { status: "not-requested" },
    }
    const [row] = changeListRows([{ pr: blockedChange(), eligibility }], [], Date.parse("2026-07-15T12:01:00.000Z"))

    // The code token is the WHY column's value — widths depend on it.
    expect(row?.why).toBe("review-rejected")
    // The human message rides alongside so a reader of the row model never
    // has to re-derive it from a second eligibility lookup.
    expect(row?.whyMessage).toBe(message)
  })

  it("a runnable row carries no whyMessage", () => {
    const eligibility: ChangeEligibility = {
      pr: "PR9",
      revision: 1,
      runnable: true,
      review: { required: false, approved: false, stale: false },
      checks: { status: "passed" },
    }
    const [row] = changeListRows([{ pr: blockedChange(), eligibility }], [], Date.parse("2026-07-15T12:01:00.000Z"))
    expect(row?.whyMessage).toBeUndefined()
  })
})
