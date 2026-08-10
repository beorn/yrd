/**
 * @failure `yrd pr list` silently drops rows it selected, hides its own window with no count of what it withheld, or labels a PR whose head is already on the base branch as if its content never landed (22376).
 * @level l2
 * @consumer @yrd/cli pr list
 *
 * Two live specimens from 2026-07-25, both on the PR-state surface, both
 * answering "what is outstanding?" with something false in opposite
 * directions: the first hid live work, the second hid landed work.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays } from "@yrd/bay"
import {
  command,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  event,
  JsonSchema,
  pipe,
  type JsonValue,
} from "@yrd/core"
import { withContests, type ContestGit } from "@yrd/contest"
import { withIntents } from "@yrd/intent"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import { withMerge, withQueue, withStep, type PRShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
import { runYrd, type PruneGitFacts, type YrdCliIO } from "@yrd/cli"
import { createLogger } from "loggily"
import { provePrLandings } from "../src/pr-landing.ts"
import { createPruneGitFacts } from "../src/pr-withdraw.ts"
import { PRListView, type PRListRow } from "../src/queue-status-view.tsx"

const WIDTH = 120
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)
const LANDED_HEAD = "c".repeat(40)
const LIVE_HEAD = "d".repeat(40)

// ---------------------------------------------------------------------------
// Specimen 1 — the view must render every row it was handed.

function row(id: number, overrides: Partial<PRListRow> = {}): PRListRow {
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

async function renderRows(rows: readonly PRListRow[]): Promise<string> {
  return renderString(createElement(PRListView, { rows, columns: WIDTH }), {
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
      _input: StepExecution<PRShape>,
    ): Promise<JobResult<{ commit: string; baseSha: string; sourceRewrites?: readonly SourceRewrite[] }>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({ steps: [check, merge] as const, batch: false })
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  const contests = withContests({ runners: [], evaluators: [], git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withIntents(),
    withBays({ jobs: bayJobs, defaultBase: "main", resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }) }),
  )
  const withdrawAfterLanding = command({
    title: "Reproduce an author withdrawal that races a completed landing",
    apply: () => ({
      events: [
        event("pr/withdrawn", {
          pr: "PR1",
          revision: 1,
          headSha: LANDED_HEAD,
          reason: "author changed their mind",
        }),
      ],
    }),
  })
  const definition = contests(queue(base)).extend({ commands: { fixture: { withdrawAfterLanding } } })
  return createYrd(definition, {
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
function landingGit(overrides: Partial<PruneGitFacts> = {}): PruneGitFacts {
  return {
    resolveCommit: (ref) =>
      ref === "origin/main" || ref === "main" ? BASE_SHA : ref === LANDED_HEAD || ref === LIVE_HEAD ? ref : undefined,
    isAncestor: (ancestor, descendant) => ancestor === LANDED_HEAD && descendant === BASE_SHA,
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

describe("pr list landing reconciliation (22376)", () => {
  it("proves a regenerated carrier from the journal landing commit, not the absent authored head", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/regenerated", headSha: LANDED_HEAD, base: "main", baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    await app.queue.run({ prs: ["PR1"] }, { runner: "pr-list-test", leaseMs: 60_000 })

    const result = await provePrLandings(app.bays.prs(), {
      ...outputIO().io,
      pruneGit: () =>
        landingGit({
          resolveCommit: (ref) =>
            ref === "origin/main" || ref === "main" ? BASE_SHA : ref === MERGED_SHA ? MERGED_SHA : undefined,
          isAncestor: (ancestor, descendant) => ancestor === MERGED_SHA && descendant === BASE_SHA,
        }),
    })

    expect(result.verdicts.get("PR1")).toEqual({
      status: "proven",
      baseSha: BASE_SHA,
      landingSha: MERGED_SHA,
    })
    expect(result.warnings).toEqual([])
  })

  it("returns typed non-proof and unknown verdicts without ancestry fallback", async () => {
    const direct = await createCliApp()
    await direct.bays.submit({ branch: "topic/direct", headSha: LANDED_HEAD, base: "main", baseSha: BASE_SHA })
    const noJournal = await provePrLandings(direct.bays.prs(), {
      ...outputIO().io,
      pruneGit: () =>
        landingGit({
          resolveCommit: () => {
            throw new Error("a PR without a journal landing must not probe Git")
          },
        }),
    })
    expect(noJournal.verdicts.get("PR1")).toEqual({ status: "not-proven", reason: "journal-missing" })

    const integrated = await createCliApp()
    await integrated.bays.submit({ branch: "topic/integrated", headSha: LANDED_HEAD, base: "main", baseSha: BASE_SHA })
    await integrated.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    await integrated.queue.run({ prs: ["PR1"] }, { runner: "pr-list-test", leaseMs: 60_000 })

    const offBase = await provePrLandings(integrated.bays.prs(), {
      ...outputIO().io,
      pruneGit: () => landingGit({ isAncestor: () => false }),
    })
    expect(offBase.verdicts.get("PR1")).toEqual({
      status: "not-proven",
      reason: "landing-not-on-base",
      baseSha: BASE_SHA,
      landingSha: MERGED_SHA,
    })

    const unknown = await provePrLandings(integrated.bays.prs(), {
      ...outputIO().io,
      pruneGit: () => landingGit({ resolveCommit: () => undefined }),
    })
    expect(unknown.verdicts.get("PR1")).toEqual({ status: "unknown", reason: "base-unresolved", base: "main" })
    expect(unknown.warnings).toEqual([
      "yrd: base 'main' did not resolve here, so 1 journal landing could not be checked against it",
    ])
  })

  it("does not call a directly pushed withdrawal landed without a queue journal row", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/landed", headSha: LANDED_HEAD, base: "main", baseSha: BASE_SHA })
    await app.bays.closePr({ pr: "PR1", reason: "author changed their mind" })

    const json = outputIO({ pruneGit: () => landingGit() })
    expect(await runYrd(app as CliApp, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
    const listed = JSON.parse(json.stdout()) as {
      prs: readonly Readonly<{ id: string; status: string; nativeStatus?: string }>[]
    }
    expect(listed.prs).toHaveLength(1)
    expect(listed.prs[0]).toMatchObject({ id: "PR1", status: "withdrawn" })

    const human = outputIO({ pruneGit: () => landingGit(), columns: 200 })
    expect(await runYrd(app as CliApp, yrd("pr", "list"), human.io), human.stderr()).toBe(0)
    expect(human.stdout()).not.toContain("already-landed")
    expect(human.stdout()).not.toContain("withdrawn-after-landing")
  })

  it("reports a withdrawn integration only when its journal landing commit is on the base", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/landed", headSha: LANDED_HEAD, base: "main", baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    await app.queue.run({ prs: ["PR1"] }, { runner: "pr-list-test", leaseMs: 60_000 })
    await app.dispatch(app.commands.fixture.withdrawAfterLanding, undefined)

    const json = outputIO({
      pruneGit: () =>
        landingGit({
          resolveCommit: (ref) =>
            ref === "origin/main" || ref === "main" ? BASE_SHA : ref === MERGED_SHA ? MERGED_SHA : undefined,
          isAncestor: (ancestor, descendant) => ancestor === MERGED_SHA && descendant === BASE_SHA,
        }),
    })
    expect(await runYrd(app as CliApp, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
    expect(
      (JSON.parse(json.stdout()) as { prs: readonly Readonly<{ id: string; status: string }>[] }).prs[0],
    ).toMatchObject({ id: "PR1", status: "already-landed" })
  })

  it("does not call a journal integration landed when its landing commit is absent from the base", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/missing-landing", headSha: LANDED_HEAD, base: "main", baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    await app.queue.run({ prs: ["PR1"] }, { runner: "pr-list-test", leaseMs: 60_000 })
    await app.dispatch(app.commands.fixture.withdrawAfterLanding, undefined)

    const json = outputIO({
      pruneGit: () =>
        landingGit({
          resolveCommit: (ref) =>
            ref === "origin/main" || ref === "main" ? BASE_SHA : ref === MERGED_SHA ? MERGED_SHA : undefined,
          isAncestor: () => false,
        }),
    })
    expect(await runYrd(app as CliApp, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
    expect(
      (JSON.parse(json.stdout()) as { prs: readonly Readonly<{ id: string; status: string }>[] }).prs[0],
    ).toMatchObject({ id: "PR1", status: "withdrawn" })
  })

  it("leaves a withdrawal whose content is not on the base alone", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/live", headSha: LIVE_HEAD, base: "main", baseSha: BASE_SHA })
    await app.bays.closePr({ pr: "PR1", reason: "superseded by a different design" })

    const json = outputIO({ pruneGit: () => landingGit() })
    expect(await runYrd(app as CliApp, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
    const listed = JSON.parse(json.stdout()) as { prs: readonly Readonly<{ id: string; status: string }>[] }
    expect(listed.prs[0]).toMatchObject({ id: "PR1", status: "withdrawn" })
  })

  /** The fake above proves the projection; this proves the plumbing under it —
   * real Git, one batched answer, against a landed head, an unlanded head, and
   * a head this repository has never seen. */
  it("answers landed / unlanded / absent from one real batched Git query", () => {
    const dir = mkdtempSync(join(tmpdir(), "yrd-pr-list-landing-"))
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()
    try {
      git("init", "-q", "-b", "main")
      git("config", "user.name", "Yrd Test")
      git("config", "user.email", "yrd@example.invalid")
      writeFileSync(join(dir, "base.md"), "base\n")
      git("add", ".")
      git("commit", "-qm", "base")

      git("switch", "-q", "-c", "topic/landed")
      writeFileSync(join(dir, "landed.md"), "landed\n")
      git("add", ".")
      git("commit", "-qm", "landed")
      const landedHead = git("rev-parse", "HEAD")

      git("switch", "-q", "-c", "topic/live", "main")
      writeFileSync(join(dir, "live.md"), "live\n")
      git("add", ".")
      git("commit", "-qm", "live")
      const liveHead = git("rev-parse", "HEAD")

      git("switch", "-q", "main")
      git("merge", "-q", "--no-ff", "-m", "merge landed", landedHead)
      const baseSha = git("rev-parse", "HEAD")

      const facts = createPruneGitFacts(dir)
      const absent = "9".repeat(40)
      expect(facts.landedOnBase?.(baseSha, [landedHead, liveHead, absent])).toEqual([landedHead])
      // The fallback path every implementation without the batch fact takes
      // must reach the same verdict, or the two rails could disagree silently.
      expect(facts.isAncestor(landedHead, baseSha)).toBe(true)
      expect(facts.isAncestor(liveHead, baseSha)).toBe(false)
      expect(facts.resolveCommit(absent)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("never probes git for a PR whose recorded state already claims a landing", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/live", headSha: LIVE_HEAD, base: "main", baseSha: BASE_SHA })

    const json = outputIO({
      pruneGit: () => ({
        ...landingGit(),
        resolveCommit: () => {
          throw new Error("a live PR needs no ancestry proof")
        },
        isAncestor: () => {
          throw new Error("a live PR needs no ancestry proof")
        },
      }),
    })
    expect(await runYrd(app as CliApp, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
    expect((JSON.parse(json.stdout()) as { prs: readonly Readonly<{ status: string }>[] }).prs[0]).toMatchObject({
      status: "submitted",
    })
  })
})
