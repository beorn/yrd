/**
 * @failure  #37838: one Workboard refresh re-enters `yrd issues` once per page, so the holds inventory and the
 *           6.1-second owner-activity command run once per page, and a read spanning pages can quietly mix two
 *           vault cuts. One entry must walk the provider's existing bounded pages, capture holds and activity
 *           exactly once, refuse a set that moved under it, and never pass a partial set off as complete
 *           (@cto 8e7cbb99, @dev/3 7a95653e).
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

type PageAnswer = Readonly<{
  snapshot?: string
  head?: number
  rows: readonly Record<string, unknown>[]
  next: string | null
  complete: boolean
}>

const row = (id: string): Record<string, unknown> => ({ path: `${id}.md`, version: `v-${id}`, row: { id, title: id } })

const pages = (answers: readonly Readonly<{ token: string | null; page: PageAnswer }>[]): string =>
  JSON.stringify(
    answers.map(({ token, page }) => ({
      token,
      page: { snapshot: SNAPSHOT, head: 7, population: 4, generation: "g", ...page },
    })),
  )

/**
 * A project whose `main` declares `traverse` against a scripted three-page provider and an activity command that
 * records its own calls, so one refresh's provider calls and activity calls are both countable.
 */
function project(
  scripted: string,
  options: Readonly<{ activity?: "ok" | "fail" }> = {},
): { root: string; pageCalls: () => number; activityCalls: () => number } {
  const base = join(realpathSync(mkdtempSync(join(tmpdir(), "yrd-traverse-"))), "project")
  roots.push(join(base, ".."))
  mkdirSync(base, { recursive: true })
  git(base, "init", "--quiet", "--initial-branch=main")
  const pagesFile = join(base, "..", "pages.json")
  writeFileSync(pagesFile, scripted)
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
          `${JSON.stringify({ path: "a.md", actor: "@dev/1", ts: Date.now() - 60_000 })}\n`,
          "<cutoff>",
        ])
  const declaration = [
    `traverse: ${JSON.stringify([BUN, PROVIDER, "pages", pageLog, pagesFile, "<page>"])}`,
    `list-page: ${JSON.stringify([BUN, PROVIDER, "pages", pageLog, pagesFile, "<page>"])}`,
    `activity: ${activity}`,
  ].join("\n")
  writeFileSync(join(base, "issues.yml"), `${declaration}\n`)
  git(base, "add", "-A")
  git(base, "commit", "--quiet", "-m", "seed")
  const count = (path: string): number => {
    try {
      return readFileSync(path, "utf8").trim().split("\n").filter((line) => line.length > 0).length
    } catch {
      return 0
    }
  }
  return { root: base, pageCalls: () => count(pageLog), activityCalls: () => count(activityLog) }
}

const basePageRequest = JSON.stringify({ binding: "workspace-a/native", population: "all-beads", generation: "first", limit: 2 })

const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString()

const hold = (name: string, issue: string): IssuesEnvironmentHold => ({ name, issue, expiresAt: inAnHour() })

async function traverse(
  root: string,
  env: Record<string, string> = {},
): Promise<Awaited<ReturnType<typeof runIssuesVerb>>> {
  return runIssuesVerb({
    verb: "traverse",
    args: [basePageRequest],
    projectRoot: root,
    cwd: root,
    env: { ...process.env, ...env },
    environments: async () => [hold("env-a", "a")],
    stderr: () => {},
  })
}

describe("#37838 one Workboard refresh enters Yrd once", () => {
  it("walks every bounded page at one snapshot and captures holds and activity once", async () => {
    const fixture = project(
      pages([
        { token: null, page: { rows: [row("a"), row("b")], next: "t2", complete: false } },
        { token: "t2", page: { rows: [row("c")], next: "t3", complete: false } },
        { token: "t3", page: { rows: [row("d")], next: null, complete: true } },
      ]),
    )
    const outcome = await traverse(fixture.root)
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    if (!outcome.ok) return

    const result = outcome.envelope.result as {
      rows: readonly { row: { id: string; in_progress: boolean | null } }[]
      snapshot: string
      next: string | null
      complete: boolean
      activityUnreadRows?: number
    }
    expect(result.rows.map((entry) => entry.row.id)).toEqual(["a", "b", "c", "d"])
    expect(result.snapshot).toBe(SNAPSHOT)
    expect(result.next).toBeNull()
    expect(result.complete).toBe(true)
    // The hold names `a`; the activity leg names `a` too, so the rest are idle — and the read happened ONCE.
    expect(result.rows.map((entry) => entry.row.in_progress)).toEqual([true, false, false, false])
    expect(fixture.pageCalls()).toBe(3)
    expect(fixture.activityCalls()).toBe(1)
  }, 120_000)

  it("refuses the whole read when a later page names another snapshot, naming page, rows and cursor", async () => {
    const fixture = project(
      pages([
        { token: null, page: { rows: [row("a"), row("b")], next: "t2", complete: false } },
        {
          token: "t2",
          page: { snapshot: "d".repeat(40), rows: [row("c")], next: null, complete: true },
        },
      ]),
    )
    const outcome = await traverse(fixture.root)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(ISSUES_CODES.pageSourceMoved)
    expect(outcome.message).toContain(`${SNAPSHOT} -> ${"d".repeat(40)}`)
    expect(outcome.message).toContain("page 2")
    expect(outcome.message).toContain("after 2 rows")
    expect(outcome.message).toContain("last cursor t2")
    expect(outcome.message).toContain("no rows served")
  }, 120_000)

  it("fails loudly at the page bound instead of answering a partial set", async () => {
    const fixture = project(
      pages([
        { token: null, page: { rows: [row("a")], next: "t2", complete: false } },
        { token: "t2", page: { rows: [row("b")], next: "t3", complete: false } },
        { token: "t3", page: { rows: [row("c")], next: null, complete: true } },
      ]),
    )
    const outcome = await traverse(fixture.root, { YRD_ISSUES_PAGE_BOUND: "2" })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(ISSUES_CODES.pageBound)
    expect(outcome.message).toContain("2-page bound")
    expect(outcome.message).toContain("2 pages")
    expect(outcome.message).toContain("2 rows")
    expect(outcome.message).toContain("last cursor t3")
    expect(outcome.message).toContain("no rows served")
  }, 120_000)

  it("counts the rows an unreadable activity source left unknown, so they cannot read as a clean page", async () => {
    const fixture = project(
      pages([{ token: null, page: { rows: [row("a"), row("b")], next: null, complete: true } }]),
      { activity: "fail" },
    )
    const outcome = await runIssuesVerb({
      verb: "traverse",
      args: [basePageRequest],
      projectRoot: fixture.root,
      cwd: fixture.root,
      env: { ...process.env },
      environments: async () => [hold("env-a", "a")],
      stderr: () => {},
    })
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    if (!outcome.ok) return
    const result = outcome.envelope.result as {
      rows: readonly { row: { id: string; in_progress: boolean | null } }[]
      activityUnreadRows?: number
    }
    expect(result.rows.map((entry) => [entry.row.id, entry.row.in_progress])).toEqual([
      ["a", true],
      ["b", null],
    ])
    expect(result.activityUnreadRows).toBe(1)
  }, 120_000)
})
