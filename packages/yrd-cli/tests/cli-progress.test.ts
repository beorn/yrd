/**
 * @failure  #37838: a Workboard refresh at an UNCHANGED native head could not learn that a hold expired or that a
 *           previously idle owner wrote — the native delta carries only rows that moved, so the 300 s full
 *           reconcile was the only thing that noticed. One refresh must now carry the complete sparse progress
 *           frame (every open hold, every qualifying identity+actor) from the SAME single capture that annotates
 *           its rows, at a cost that follows the qualifying set and never the store (@cto 3083a003).
 * @level    l2 (a real Git repository and real provider processes; environments injected)
 * @testonly none
 * @consumer the Workboard refresh · @dev/17 Workboard projection
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
const row = (id: string, owner = ""): Record<string, unknown> => ({
  path: `${id}.md`,
  version: `v-${id}`,
  row: { id, title: id, ...(owner === "" ? {} : { owner }) },
})

type PageAnswer = Readonly<{ rows: readonly Record<string, unknown>[]; next: string | null; complete: boolean }>

const streamed = (answers: readonly PageAnswer[]): string => {
  const population = answers.reduce((total, answer) => total + answer.rows.length, 0)
  return JSON.stringify(answers.map((page) => ({ snapshot: SNAPSHOT, head: 7, generation: "g", population, ...page })))
}

type Fixture = {
  root: string
  pageCalls: () => number
  activityCalls: () => number
  /** The `<page>` value as the declared provider actually received it. */
  providerRequests: () => readonly string[]
}

function project(
  documents: string,
  options: Readonly<{
    activity?: "ok" | "fail" | "none"
    events?: readonly { path: string; actor: string; ts: number }[]
    listPage?: string
  }> = {},
): Fixture {
  const base = join(realpathSync(mkdtempSync(join(tmpdir(), "yrd-progress-"))), "project")
  roots.push(join(base, ".."))
  mkdirSync(base, { recursive: true })
  git(base, "init", "--quiet", "--initial-branch=main")
  const pagesFile = join(base, "..", "pages.json")
  writeFileSync(pagesFile, documents)
  const pageLog = join(base, "..", "page-calls.log")
  const activityLog = join(base, "..", "activity-calls.log")
  const lines = [
    `list-page: ${options.listPage ?? JSON.stringify([BUN, PROVIDER, "stream", pageLog, pagesFile, "<page>"])}`,
  ]
  if (options.activity !== "none") {
    const activity =
      options.activity === "fail"
        ? JSON.stringify([BUN, PROVIDER, "exit3"])
        : JSON.stringify([
            BUN,
            PROVIDER,
            "count",
            activityLog,
            `${(options.events ?? []).map((event) => JSON.stringify(event)).join("\n")}\n`,
            "<cutoff>",
          ])
    lines.push(`activity: ${activity}`)
  }
  writeFileSync(join(base, "issues.yml"), `${lines.join("\n")}\n`)
  git(base, "add", "-A")
  git(base, "commit", "--quiet", "-m", "seed")
  const log = (path: string): readonly string[] => {
    try {
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
    } catch {
      return []
    }
  }
  return {
    root: base,
    pageCalls: () => log(pageLog).length,
    activityCalls: () => log(activityLog).length,
    providerRequests: () => log(pageLog).map((line) => (JSON.parse(line) as { request: string }).request),
  }
}

const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString()
const anHourAgo = (): string => new Date(Date.now() - 3_600_000).toISOString()
const hold = (name: string, issue: string, expiresAt = inAnHour()): IssuesEnvironmentHold => ({
  name,
  issue,
  expiresAt,
})

type Outcome = Awaited<ReturnType<typeof runIssuesVerb>>
type Entry = Readonly<{ id: string; owner?: string; reason: string }>
type ProgressAnswer = Readonly<{
  qualifying: readonly Entry[]
  default: false | null
  source: "ok" | "undeclared" | "unreadable"
  complete: true
}>

async function listPage(
  root: string,
  request: Readonly<Record<string, unknown>>,
  options: Readonly<{
    environments?: (() => Promise<readonly IssuesEnvironmentHold[]>) | null
  }> = {},
): Promise<Outcome> {
  return runIssuesVerb({
    verb: "list-page",
    args: [JSON.stringify(request)],
    projectRoot: root,
    cwd: root,
    env: process.env,
    ...(options.environments === null ? {} : { environments: options.environments ?? (async () => []) }),
    stderr: () => {},
  })
}

/** The frame rides the TERMINAL answer of a refresh, whichever number of pages it took. */
const progressOf = (outcome: Outcome): ProgressAnswer | undefined => {
  if (!outcome.ok) return undefined
  const envelopes = outcome.stream ?? [outcome.envelope]
  const terminal = envelopes[envelopes.length - 1]
  return terminal === undefined ? undefined : (terminal.result as { progress?: ProgressAnswer }).progress
}

/** The reason the ordinary annotation put on one row, so the frame can be held to exactly the same words. */
const rowReason = (outcome: Outcome, id: string): string | null | undefined => {
  if (!outcome.ok) return undefined
  for (const envelope of outcome.stream ?? [outcome.envelope]) {
    const rows = (envelope.result as { rows?: readonly { row: { id: string; in_progress_reason?: string | null } }[] })
      .rows
    const found = rows?.find((entry) => entry.row.id === id)
    if (found !== undefined) return found.row.in_progress_reason
  }
  return undefined
}

describe("#37838 one refresh carries the complete progress frame", () => {
  it("answers the frame from the same single capture that annotates the rows, in the rows' own words", async () => {
    const fixture = project(streamed([{ rows: [row("a"), row("b", "@dev/1")], next: null, complete: true }]), {
      events: [{ path: "b.md", actor: "@dev/1", ts: Date.now() - 60_000 }],
    })
    const outcome = await listPage(
      fixture.root,
      { binding: "workspace-a/native", traverse: true, progress: true },
      {
        environments: async () => [hold("env-a", "a")],
      },
    )
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    // ONE provider call and ONE activity call: asking for the frame never buys a second capture.
    expect(fixture.pageCalls()).toBe(1)
    expect(fixture.activityCalls()).toBe(1)
    const progress = progressOf(outcome)
    expect(progress?.default).toBe(false)
    expect(progress?.source).toBe("ok")
    expect(progress?.complete).toBe(true)
    expect(progress?.qualifying.map((entry) => entry.id)).toEqual(["path:a", "path:b"])
    // A hold entry is identity-only; an activity entry carries the actor so the reader joins on its cached owner.
    expect(progress?.qualifying[0]).not.toHaveProperty("owner")
    expect(progress?.qualifying[1]?.owner).toBe("@dev/1")
    // Same words as the row itself — the consumer never re-derives a reason.
    expect(progress?.qualifying[0]?.reason).toBe(rowReason(outcome, "a"))
    expect(progress?.qualifying[1]?.reason).toBe(rowReason(outcome, "b"))
  }, 120_000)

  it("answers a progress-only request without entering the native list path at all", async () => {
    const fixture = project("[]", { events: [{ path: "a.md", actor: "@dev/1", ts: Date.now() - 60_000 }] })
    const outcome = await listPage(
      fixture.root,
      { progress: true },
      {
        environments: async () => [hold("env-a", "a")],
      },
    )
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    expect(fixture.pageCalls()).toBe(0)
    expect(fixture.activityCalls()).toBe(1)
    if (!outcome.ok) return
    // The frame IS the answer: nothing native was read, so no rows and no stream.
    expect(outcome.stream).toBeUndefined()
    expect(Object.keys(outcome.envelope.result as Record<string, unknown>)).toEqual(["progress"])
    expect(progressOf(outcome)?.qualifying.map((entry) => entry.id)).toEqual(["path:a"])
  }, 120_000)

  it("names a hold beyond row 5000 and drops one that expired, at an unchanged native head", async () => {
    const rows = Array.from({ length: 5_002 }, (_unused, index) => row(`r${String(index)}`))
    const fixture = project(
      streamed([
        { rows: rows.slice(0, 2_000), next: "t2", complete: false },
        { rows: rows.slice(2_000, 4_000), next: "t3", complete: false },
        { rows: rows.slice(4_000), next: null, complete: true },
      ]),
      { events: [{ path: "r5001.md", actor: "@dev/9", ts: Date.now() - 60_000 }] },
    )
    const outcome = await listPage(
      fixture.root,
      { traverse: true, progress: true },
      {
        environments: async () => [hold("env-old", "r1", anHourAgo())],
      },
    )
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    const progress = progressOf(outcome)
    expect(progress?.qualifying).toHaveLength(1)
    expect(progress?.qualifying[0]?.id).toBe("path:r5001")
    expect(progress?.qualifying[0]?.owner).toBe("@dev/9")
    expect(progress?.qualifying[0]?.reason).toContain("owner @dev/9, active ")
    // The expired hold qualified nothing, and the frame cost ONE activity read for all 5,002 rows.
    expect(fixture.activityCalls()).toBe(1)
  }, 120_000)

  it("keeps a bead's identity across a move and prefers the hold over any owner's write", async () => {
    const fixture = project(streamed([{ rows: [], next: null, complete: true }]), {
      events: [{ path: "@i/x/37838-old-name.md", actor: "@dev/1", ts: Date.now() - 60_000 }],
    })
    const outcome = await listPage(
      fixture.root,
      { progress: true },
      {
        environments: async () => [hold("env-moved", "@i/x/37838-new-name.md")],
      },
    )
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    // One entry: the hold already qualified `bead:37838`, whatever the actor wrote to the old path.
    expect(progressOf(outcome)?.qualifying).toEqual([{ id: "bead:37838", reason: "environment env-moved" }])
  }, 120_000)

  it("uses the path identity for a row that is not a bead, including a date-prefixed leaf", async () => {
    const fixture = project("[]")
    const outcome = await listPage(
      fixture.root,
      { progress: true },
      {
        environments: async () => [hold("env-doc", "@i/x/README.md"), hold("env-day", "@i/x/2026-11-22-notes.md")],
      },
    )
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    expect([...(progressOf(outcome)?.qualifying ?? [])].map((entry) => entry.id).sort()).toEqual([
      "path:@i/x/2026-11-22-notes",
      "path:@i/x/README",
    ])
  }, 120_000)

  it("carries an unreadable activity source as a null default, not as a false one", async () => {
    const fixture = project(streamed([{ rows: [row("a")], next: null, complete: true }]), { activity: "fail" })
    const outcome = await listPage(
      fixture.root,
      { traverse: true, progress: true },
      {
        environments: async () => [hold("env-a", "a")],
      },
    )
    // The refresh still answers: a failed activity leg is a typed default, not a failed read.
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    const progress = progressOf(outcome)
    expect(progress?.source).toBe("unreadable")
    expect(progress?.default).toBeNull()
    expect(progress?.complete).toBe(true)
    // A hold is still a fact; only the leg that failed is unknown.
    expect(progress?.qualifying.map((entry) => entry.id)).toEqual(["path:a"])
  }, 120_000)

  it("says undeclared, with a false default, when the project declares no activity source", async () => {
    const fixture = project(streamed([{ rows: [row("a")], next: null, complete: true }]), { activity: "none" })
    const outcome = await listPage(
      fixture.root,
      { traverse: true, progress: true },
      {
        environments: async () => [hold("env-a", "a")],
      },
    )
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    expect(progressOf(outcome)?.source).toBe("undeclared")
    expect(progressOf(outcome)?.default).toBe(false)
  }, 120_000)

  it("refuses by name when the environment read fails instead of publishing a frame without holds", async () => {
    const fixture = project("[]")
    const outcome = await listPage(
      fixture.root,
      { progress: true },
      {
        environments: async () => {
          throw new Error("no environment home for origin")
        },
      },
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(ISSUES_CODES.environmentUnreadable)
    expect(outcome.message).toContain("no environment home for origin")
    expect(outcome.message).toContain("no progress frame is complete without the holds it could not read")
  }, 120_000)

  it("refuses progress when this caller supplies no environment source at all", async () => {
    const fixture = project("[]")
    const outcome = await listPage(fixture.root, { progress: true }, { environments: null })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(ISSUES_CODES.environmentUnreadable)
    expect(outcome.message).toContain("supplied none")
  }, 120_000)

  it("never lets Yrd's own progress flag reach the declared provider", async () => {
    const fixture = project(streamed([{ rows: [row("a")], next: null, complete: true }]))
    const outcome = await listPage(fixture.root, {
      binding: "workspace-a/native",
      limit: 10,
      traverse: true,
      progress: true,
    })
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    const [request] = fixture.providerRequests()
    expect(request).toBeDefined()
    expect(JSON.parse(request as string)).toEqual({ binding: "workspace-a/native", limit: 10, traverse: true })
  }, 120_000)

  it("passes an ordinary page request through byte for byte, whitespace included", async () => {
    const fixture = project(streamed([{ rows: [row("a")], next: null, complete: true }]))
    const request = '{"binding":"workspace-a/native",  "limit":1e3}'
    const outcome = await runIssuesVerb({
      verb: "list-page",
      args: [request],
      projectRoot: fixture.root,
      cwd: fixture.root,
      env: process.env,
      environments: async () => [],
      stderr: () => {},
    })
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    expect(fixture.providerRequests()[0]).toBe(request)
  }, 120_000)

  it("leaves an ordinary request byte-identical: no frame, no extra key", async () => {
    const fixture = project(streamed([{ rows: [row("a")], next: null, complete: true }]))
    const outcome = await listPage(fixture.root, { binding: "workspace-a/native", limit: 10 })
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    if (!outcome.ok) return
    expect(outcome.stream).toBeUndefined()
    expect(outcome.envelope.result).not.toHaveProperty("progress")
    expect(progressOf(outcome)).toBeUndefined()
  }, 120_000)

  it("refuses a frame it has nowhere to ride rather than dropping it silently", async () => {
    const fixture = project("", { listPage: JSON.stringify([BUN, PROVIDER, "reply", '"not a page"', "<page>"]) })
    const outcome = await listPage(fixture.root, { binding: "workspace-a/native", progress: true })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(ISSUES_CODES.providerInvalidResult)
    expect(outcome.message).toContain("to carry the frame")
  }, 120_000)
})
