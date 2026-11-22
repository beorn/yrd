/**
 * @failure  #37838: one Workboard refresh re-entered `yrd issues` once per page, so the holds inventory and the
 *           owner-activity command ran once per page, and a read spanning pages could quietly mix two vault cuts —
 *           measured on /hh/pm, a token loop refused at page 11 after 124 s because the live vault landed mid-read.
 *           ONE `list-page` entry must read the provider's pages from ONE process at one snapshot when its own
 *           `<page>` request says `traverse:true`, capture holds and activity exactly once, refuse a set that
 *           moved under it, and never pass a partial set off as complete (@cto ead63117, e1873f39).
 * @level    l2 (a real Git repository and real provider processes; environments injected)
 * @testonly none
 * @consumer the Workboard refresh · @dev/3 paged reader · @dev/17 Workboard projection
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, describe, expect, it } from "vitest"
import { ISSUES_CODES } from "../src/issues/declaration.ts"
import { runIssuesVerb, type IssuesEnvironmentHold } from "../src/issues/run.ts"

const PROVIDER = resolve(import.meta.dirname, "support/fake-issues-provider.ts")
const BUN = process.execPath
const TMP = realpathSync(tmpdir())
const roots: string[] = []

afterAll(() => {
  for (const root of roots) safeRemoveSync(root, { within: TMP, allowedRoots: [TMP], allowMissing: true })
})

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

const SNAPSHOT = "c".repeat(40)
const OTHER = "d".repeat(40)

type PageAnswer = Readonly<{
  snapshot?: string
  head?: number
  population?: number
  rows: readonly Record<string, unknown>[]
  next: string | null
  complete: boolean
}>

const row = (id: string): Record<string, unknown> => ({ path: `${id}.md`, version: `v-${id}`, row: { id, title: id } })

/** The page documents the fake provider streams from one process, exactly as km's `traverse` writes them. */
const streamed = (answers: readonly PageAnswer[]): string => {
  const population = answers.reduce((total, answer) => total + answer.rows.length, 0)
  return JSON.stringify(answers.map((page) => ({ snapshot: SNAPSHOT, head: 7, generation: "g", population, ...page })))
}

/**
 * A project whose `main` declares one `list-page` entry against a provider that streams its pages for a
 * `traverse:true` request, plus an activity command that records its own calls, so one refresh's provider calls
 * and activity calls are both countable.
 */
function project(
  documents: string,
  options: Readonly<{
    activity?: "ok" | "fail"
    events?: readonly { path: string; actor: string; ts: number }[]
    listPage?: string
  }> = {},
): { root: string; pageCalls: () => number; activityCalls: () => number } {
  const base = join(realpathSync(mkdtempSync(join(tmpdir(), "yrd-traverse-"))), "project")
  roots.push(join(base, ".."))
  mkdirSync(base, { recursive: true })
  git(base, "init", "--quiet", "--initial-branch=main")
  const pagesFile = join(base, "..", "pages.json")
  writeFileSync(pagesFile, documents)
  const pageLog = join(base, "..", "page-calls.log")
  const activityLog = join(base, "..", "activity-calls.log")
  const activity =
    options.activity === "fail"
      ? JSON.stringify([BUN, PROVIDER, "exit3"])
      : JSON.stringify([
          BUN,
          PROVIDER,
          "count",
          activityLog,
          `${(options.events ?? [{ path: "a.md", actor: "@dev/1", ts: Date.now() - 60_000 }])
            .map((event) => JSON.stringify(event))
            .join("\n")}\n`,
          "<cutoff>",
        ])
  const declaration = [
    `list-page: ${options.listPage ?? JSON.stringify([BUN, PROVIDER, "stream", pageLog, pagesFile, "<page>"])}`,
    `activity: ${activity}`,
  ].join("\n")
  writeFileSync(join(base, "issues.yml"), `${declaration}\n`)
  git(base, "add", "-A")
  git(base, "commit", "--quiet", "-m", "seed")
  const count = (path: string): number => {
    try {
      return readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0).length
    } catch {
      return 0
    }
  }
  return { root: base, pageCalls: () => count(pageLog), activityCalls: () => count(activityLog) }
}

/** The same `list-page` verb and declaration every caller uses; only the `<page>` request opts in. */
const pageRequest = (traverse: boolean): string =>
  JSON.stringify({
    binding: "workspace-a/native",
    population: "all-beads",
    generation: "first",
    limit: 2,
    ...(traverse ? { traverse: true } : {}),
  })

const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString()

const hold = (name: string, issue: string): IssuesEnvironmentHold => ({ name, issue, expiresAt: inAnHour() })

type Outcome = Awaited<ReturnType<typeof runIssuesVerb>>

async function listPage(
  root: string,
  traverse: boolean,
  environments: () => Promise<readonly IssuesEnvironmentHold[]> = async () => [hold("env-a", "a")],
): Promise<Outcome> {
  return runIssuesVerb({
    verb: "list-page",
    args: [pageRequest(traverse)],
    projectRoot: root,
    cwd: root,
    env: process.env,
    environments,
    stderr: () => {},
  })
}

/** The page envelopes one answer carries: the stream for a traversal, the single envelope for anyone else. */
const pagesOf = (outcome: Outcome): readonly Record<string, unknown>[] =>
  outcome.ok ? (outcome.stream ?? [outcome.envelope]).map((envelope) => envelope.result as Record<string, unknown>) : []

describe("#37838 one Workboard refresh enters Yrd once", () => {
  it("reads every page from one process at one snapshot and captures holds and activity once", async () => {
    const fixture = project(
      streamed([
        { rows: [row("a"), row("b")], next: "t2", complete: false },
        { rows: [row("c")], next: "t3", complete: false },
        { rows: [row("d")], next: null, complete: true },
      ]),
    )
    const outcome = await listPage(fixture.root, true)
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    const pages = pagesOf(outcome)
    // One envelope per page, each a page answer — never one object holding every row.
    expect(pages).toHaveLength(3)
    expect(outcome.ok && outcome.envelope.verb).toBe("list-page")
    expect(pages.map((page) => page.snapshot)).toEqual([SNAPSHOT, SNAPSHOT, SNAPSHOT])
    expect(pages.map((page) => page.population)).toEqual([4, 4, 4])
    expect(pages.map((page) => (page.rows as readonly { row: { id: string } }[]).map((entry) => entry.row.id))).toEqual(
      [["a", "b"], ["c"], ["d"]],
    )
    const terminal = pages[pages.length - 1] as Record<string, unknown>
    expect(terminal.next).toBeNull()
    expect(terminal.complete).toBe(true)
    expect(terminal.meta).toEqual({ activityUnreadRows: 0 })
    // The hold names `a`; the activity leg names `a` too, so the rest are idle — and both were read ONCE.
    const annotated = pages.flatMap(
      (page) => page.rows as readonly { row: { id: string; in_progress: boolean | null } }[],
    )
    expect(annotated.map((entry) => [entry.row.id, entry.row.in_progress])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
      ["d", false],
    ])
    expect(fixture.pageCalls()).toBe(1)
    expect(fixture.activityCalls()).toBe(1)
  }, 120_000)

  it("answers one page, one envelope and one provider call when the request does not opt in", async () => {
    const fixture = project(
      streamed([
        { rows: [row("a")], next: "t2", complete: false },
        { rows: [row("b")], next: null, complete: true },
      ]),
    )
    const outcome = await listPage(fixture.root, false)
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    if (!outcome.ok) return
    // Byte-identical to today: no stream, the provider's own single page answer passed back annotated.
    expect(outcome.stream).toBeUndefined()
    const result = outcome.envelope.result as {
      rows: readonly { row: { id: string } }[]
      next: string | null
      complete: boolean
    }
    expect(result.rows.map((entry) => entry.row.id)).toEqual(["a"])
    expect(result.next).toBe("t2")
    expect(result.complete).toBe(false)
    expect(fixture.pageCalls()).toBe(1)
  }, 120_000)

  it("still reads a single-page provider that answers one JSON object", async () => {
    const single = JSON.stringify({
      snapshot: SNAPSHOT,
      head: 7,
      population: 1,
      rows: [row("a")],
      next: null,
      complete: true,
    })
    const fixture = project("", {
      listPage: JSON.stringify([BUN, PROVIDER, "reply", single, "<page>"]),
    })
    const outcome = await listPage(fixture.root, true)
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    const pages = pagesOf(outcome)
    expect(pages).toHaveLength(1)
    const result = pages[0] as { rows: readonly { row: { id: string } }[]; complete: boolean }
    expect(result.rows.map((entry) => entry.row.id)).toEqual(["a"])
    expect(result.complete).toBe(true)
    expect(fixture.activityCalls()).toBe(1)
  }, 120_000)

  it("refuses the whole read when a later page names another snapshot, naming page, rows and cursor", async () => {
    const fixture = project(
      streamed([
        { rows: [row("a"), row("b")], next: "t2", complete: false },
        { snapshot: OTHER, rows: [row("c")], next: null, complete: true },
      ]),
    )
    const outcome = await listPage(fixture.root, true)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(ISSUES_CODES.pageSourceMoved)
    expect(outcome.message).toContain(`${SNAPSHOT} -> ${OTHER}`)
    expect(outcome.message).toContain("page 2")
    expect(outcome.message).toContain("after 2 rows")
    expect(outcome.message).toContain("last cursor t2")
    expect(outcome.message).toContain("no rows served")
  }, 120_000)

  it("refuses a complete set whose terminal count disagrees with the rows actually read", async () => {
    const fixture = project(streamed([{ population: 9, rows: [row("a"), row("b")], next: null, complete: true }]))
    const outcome = await listPage(fixture.root, true)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(ISSUES_CODES.providerInvalidResult)
    expect(outcome.message).toContain("read 2 rows")
    expect(outcome.message).toContain("population 9")
    expect(outcome.message).toContain("no rows served")
  }, 120_000)

  it("refuses trailing output after the terminal complete frame instead of publishing it", async () => {
    const fixture = project(
      streamed([
        { rows: [row("a")], next: null, complete: true },
        { rows: [row("b")], next: null, complete: true },
      ]),
    )
    const outcome = await listPage(fixture.root, true)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(ISSUES_CODES.providerInvalidResult)
    expect(outcome.message).toContain("terminal page (1) says complete")
    expect(outcome.message).toContain("1 more page(s) after it")
    expect(outcome.message).toContain("no rows served")
  }, 120_000)

  it("answers the 256th complete page and refuses an incomplete 256th at the internal bound", async () => {
    const full = Array.from({ length: 256 }, (_, index) => ({
      rows: [row(`r${String(index)}`)],
      next: index === 255 ? null : `t${String(index)}`,
      complete: index === 255,
    }))
    const answered = await listPage(project(streamed(full)).root, true)
    expect(answered.ok, answered.ok ? "" : answered.message).toBe(true)
    expect(pagesOf(answered)).toHaveLength(256)

    const oneTooMany = [
      ...full.slice(0, 255),
      { rows: [row("r255")], next: "t255", complete: false },
      { rows: [row("r256")], next: null, complete: true },
    ]
    const refused = await listPage(project(streamed(oneTooMany)).root, true)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe(ISSUES_CODES.pageBound)
    expect(refused.message).toContain("256-page bound")
    expect(refused.message).toContain("256 pages")
    expect(refused.message).toContain("256 rows")
    expect(refused.message).toContain("last cursor t255")
    expect(refused.message).toContain("no rows served")
  }, 120_000)

  it("counts the rows an unreadable activity source left unknown, so they cannot read as a clean page", async () => {
    const fixture = project(streamed([{ rows: [row("a"), row("b")], next: null, complete: true }]), {
      activity: "fail",
    })
    const outcome = await listPage(fixture.root, true)
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    const pages = pagesOf(outcome)
    const terminal = pages[pages.length - 1] as {
      rows: readonly { row: { id: string; in_progress: boolean | null } }[]
      meta?: { activityUnreadRows?: number }
    }
    expect(terminal.rows.map((entry) => [entry.row.id, entry.row.in_progress])).toEqual([
      ["a", true],
      ["b", null],
    ])
    expect(terminal.meta?.activityUnreadRows).toBe(1)
  }, 120_000)

  // @cto 80894587: a hold can end or activity can age out with NO store edit, so the next refresh must correct
  // the row. The traversal re-reads the whole set every time, which is what makes the correction possible.
  it("flips a row whose owner activity aged out although every page answer is identical", async () => {
    const window = 24 * 60 * 60 * 1000
    const fixture = project(
      streamed([
        { rows: [{ ...row("a"), row: { id: "a", title: "a", owner: "@dev/1" } }], next: null, complete: true },
      ]),
      { events: [{ path: "a.md", actor: "@dev/1", ts: Date.now() - window + 400 }] },
    )
    const refresh = async (): Promise<boolean | null> => {
      const outcome = await listPage(fixture.root, true, async () => [])
      expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
      const pages = pagesOf(outcome)
      const rows = (pages[pages.length - 1]?.rows ?? []) as readonly { row: { in_progress: boolean | null } }[]
      return rows[0]?.row.in_progress ?? null
    }

    expect(await refresh()).toBe(true)
    await Bun.sleep(1_200)
    // Same snapshot, same rows, same page document: only the captured cutoff moved past the write.
    expect(await refresh()).toBe(false)
    expect(fixture.pageCalls()).toBe(2)
    expect(fixture.activityCalls()).toBe(2)
  }, 120_000)
})
