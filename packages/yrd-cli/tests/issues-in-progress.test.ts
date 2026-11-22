/**
 * @failure  #37838: `yrd issues` answered what an issue *is* and never whether anyone is working it, so a
 *           workboard could not tell a claimed item from a free one. The columns must come from the one place
 *           that knows — Yrd's own open environments — joined on the provider's issue key, because a second
 *           issues implementation beside `yrd issues` would drift, and a column read as absent would silently
 *           read as false.
 * @level    l2 (a temporary real Git repository and a real provider process; environments injected)
 * @testonly none
 * @consumer Hightea's km-source page reader · the Workboard grouping · every `yrd issues` row reader
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, describe, expect, it } from "vitest"
import { OWNER_ACTIVITY_WINDOW_MS, annotateInProgress, type InProgressAnnotation } from "../src/issues/in-progress.ts"
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

/**
 * A one-repository project whose `main` declares the given verbs, each answered with a fixed payload. A string
 * value is that verb's literal answer (the activity leg's JSON lines); null answers an operand echoed back.
 */
function project(payloads: Readonly<Record<string, unknown>>): string {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "yrd-in-progress-"))), "project")
  roots.push(join(root, ".."))
  mkdirSync(root, { recursive: true })
  git(root, "init", "--quiet", "--initial-branch=main")
  const declaration = Object.entries(payloads)
    .map(([verb, literal]) =>
      verb === "activity"
        ? `${verb}: ${JSON.stringify([BUN, PROVIDER, "reply", literal as string, "<cutoff>"])}`
        : `${verb}: ${JSON.stringify([BUN, PROVIDER, "reply", `<${verb === "view" ? "key" : "page"}>`])}`,
    )
    .join("\n")
  writeFileSync(join(root, "issues.yml"), `${declaration}\n`)
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "seed")
  return root
}

const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString()
const anHourAgo = (): string => new Date(Date.now() - 3_600_000).toISOString()

const hold = (name: string, issue: string, expiresAt?: string): IssuesEnvironmentHold => ({
  name,
  issue,
  ...(expiresAt === undefined ? {} : { expiresAt }),
})

const page = (rows: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  snapshot: "c".repeat(40),
  generation: "g",
  head: rows.length,
  population: rows.length,
  rows: rows.map((row) => ({ path: `${String(row.id)}.md`, version: "v", row })),
  next: null,
  complete: true,
})

const issue = (id: string, status = "open"): Record<string, unknown> => ({
  id,
  title: id,
  status,
  owner: "",
})

type PageRow = Readonly<{ in_progress: boolean; in_progress_reason: string | null }>

async function pageRows(
  root: string,
  rows: readonly Record<string, unknown>[],
  holds: readonly IssuesEnvironmentHold[],
): Promise<readonly PageRow[]> {
  const outcome = await runIssuesVerb({
    verb: "list-page",
    args: [JSON.stringify(page(rows))],
    projectRoot: root,
    cwd: root,
    environments: async () => holds,
    stderr: () => {},
  })
  expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
  if (!outcome.ok) throw new Error(outcome.message)
  const result = outcome.envelope.result as { rows: readonly { row: PageRow }[] }
  return result.rows.map((entry) => entry.row)
}

describe("#37838 computed in_progress", () => {
  // @failure An issue nobody has an environment for reads false; a bound open environment reads named.
  // @level l2 @consumer Hightea km-source · Workboard grouping
  it("marks a page row in progress through its open environment and leaves the rest idle", async () => {
    const root = project({ "list-page": null })
    const rows = await pageRows(
      root,
      [issue("a"), issue("b"), issue("c")],
      [hold("env-open", "a", inAnHour()), hold("env-closed", "c", anHourAgo())],
    )
    expect(rows).toEqual([
      { id: "a", title: "a", status: "open", owner: "", in_progress: true, in_progress_reason: "environment env-open" },
      { id: "b", title: "b", status: "open", owner: "", in_progress: false, in_progress_reason: null },
      { id: "c", title: "c", status: "open", owner: "", in_progress: false, in_progress_reason: null },
    ])
  })

  // @failure Without an expiry the environment is open for as long as it exists; a future expiry is still open.
  it("reads an environment with no expiry, or one still ahead, as open", async () => {
    const root = project({ "list-page": null })
    const rows = await pageRows(root, [issue("a"), issue("b")], [hold("steady", "a"), hold("timed", "b", inAnHour())])
    expect(rows.map((row) => row.in_progress)).toEqual([true, true])
    expect(rows.map((row) => row.in_progress_reason)).toEqual(["environment steady", "environment timed"])
  })

  // @failure Two environments naming one issue: the answer must be stable, not map-iteration order.
  it("names one environment deterministically when two are open on the same issue", async () => {
    const root = project({ "list-page": null })
    const rows = await pageRows(root, [issue("a")], [hold("zulu", "a"), hold("alpha", "a")])
    expect(rows[0]?.in_progress_reason).toBe("environment alpha")
  })

  // @failure AC2's boundaries, exactly: an expiry that has arrived is closed and a record exactly one window old
  //          is outside it, because "still open" and "inside 24 h" are both strict comparisons.
  it("holds both cutoffs exactly: an expiry at now and a write at now minus 24 h do not qualify", () => {
    const now = 1_760_000_000_000
    const view = (owner: string, holdExpiry?: string, eventTs?: number) =>
      annotateInProgress(
        "view",
        { id: "@hh/tooling/1234-boundary", title: "t", status: "open", owner },
        {
          holds:
            holdExpiry === undefined
              ? []
              : [{ name: "env", issue: "@hh/tooling/1234-boundary", expiresAt: holdExpiry }],
          ...(eventTs === undefined
            ? {}
            : { activity: [{ path: "@hh/tooling/1234-boundary.md", actor: "@dev/10", ts: eventTs }] }),
        },
        now,
      )
    const columnsOf = (annotation: InProgressAnnotation) => {
      if (!annotation.ok) throw new Error(annotation.detail)
      return annotation.result as PageRow
    }
    expect(columnsOf(view("@dev/10", new Date(now).toISOString())).in_progress).toBe(false)
    expect(columnsOf(view("@dev/10", new Date(now + 1).toISOString())).in_progress).toBe(true)
    expect(columnsOf(view("@dev/10", undefined, now - OWNER_ACTIVITY_WINDOW_MS)).in_progress).toBe(false)
    expect(columnsOf(view("@dev/10", undefined, now - OWNER_ACTIVITY_WINDOW_MS + 1)).in_progress).toBe(true)
  })

  // @failure `view` carries the same columns beside status and owner, and only for its own issue.
  it("adds the columns to a view and refuses another issue's environment", async () => {
    const root = project({ view: null })
    const payload = JSON.stringify(issue("@hh/tooling/37821-git-c-walks-up-to-root-repo", "in_progress"))
    const shelved = JSON.stringify(issue("@hh/tooling/1-other"))
    const read = async (key: string, holds: readonly IssuesEnvironmentHold[]) => {
      const outcome = await runIssuesVerb({
        verb: "view",
        args: [key],
        projectRoot: root,
        cwd: root,
        environments: async () => holds,
        stderr: () => {},
      })
      expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
      if (!outcome.ok) throw new Error(outcome.message)
      return outcome.envelope.result as PageRow & { status: string }
    }
    const held = await read(payload, [hold("37821-git-c-walk-up", "@hh/tooling/37821-git-c-walks-up-to-root-repo")])
    expect(held).toMatchObject({
      status: "in_progress",
      in_progress: true,
      in_progress_reason: "environment 37821-git-c-walk-up",
    })
    const other = await read(payload, [hold("elsewhere", "@hh/tooling/1-other")])
    expect(other).toMatchObject({ in_progress: false, in_progress_reason: null })
    expect(shelved.length).toBeGreaterThan(0)
  })

  // @failure An expiry the reader cannot parse must not become "closed" by accident, which reads as free work.
  it("fails loudly on an unreadable expiry instead of answering false", async () => {
    const root = project({ "list-page": null })
    const outcome = await runIssuesVerb({
      verb: "list-page",
      args: [JSON.stringify(page([issue("a")]))],
      projectRoot: root,
      cwd: root,
      environments: async () => [hold("mystery", "a", "next tuesday")],
      stderr: () => {},
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.exitCode).toBe(1)
    expect(outcome.code).toBe("yrd-issues-environment-unreadable")
  })

  // @failure An environment table that cannot be read is not "no environments": the answer stays whole and the
  //          reason is named, so a row reader can refuse an answer without the columns.
  it("names an unreadable environment table instead of marking every issue free", async () => {
    const root = project({ view: null })
    const notices: string[] = []
    const outcome = await runIssuesVerb({
      verb: "view",
      args: [JSON.stringify(issue("a"))],
      projectRoot: root,
      cwd: root,
      environments: async () => {
        throw new Error("environment store unreadable")
      },
      stderr: (text) => notices.push(text),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.envelope.result).toEqual({ id: "a", title: "a", status: "open", owner: "" })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("in_progress columns unavailable")
    expect(notices[0]).toContain("environment store unreadable")
  })

  // @failure A page row without a key cannot be classified; guessing false hides an issue somebody is working.
  it("fails loudly when a page row carries no issue key", async () => {
    const root = project({ "list-page": null })
    const outcome = await runIssuesVerb({
      verb: "list-page",
      args: [JSON.stringify({ rows: [{ path: "a.md", version: "v", row: { title: "no id" } }] })],
      projectRoot: root,
      cwd: root,
      environments: async () => [],
      stderr: () => {},
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe("yrd-issues-provider-invalid-result")
    expect(outcome.message).toContain("no string id")
  })

  // @failure The interface's own contract: provider JSON that is not an issue answer passes back whole, and the
  //          skip is named on stderr rather than leaving a reader to read an absent column as false.
  it("passes an unrecognised provider answer back whole and says the columns were skipped", async () => {
    const root = project({ view: null, "list-page": null })
    const notices: string[] = []
    for (const [verb, arg] of [
      ["view", JSON.stringify({ argv: ["<key>"] })],
      ["list-page", JSON.stringify({ argv: ["<page>"] })],
    ] as const) {
      const bare = await runIssuesVerb({ verb, args: [arg], projectRoot: root, cwd: root, stderr: () => {} })
      const outcome = await runIssuesVerb({
        verb,
        args: [arg],
        projectRoot: root,
        cwd: root,
        environments: async () => [hold("env-open", "a", inAnHour())],
        stderr: (text) => notices.push(text),
      })
      expect(bare.ok, bare.ok ? "" : bare.message).toBe(true)
      expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
      if (!outcome.ok || !bare.ok) throw new Error("both runs must answer an envelope")
      expect(outcome.envelope.result).toEqual(bare.envelope.result)
    }
    expect(notices).toHaveLength(2)
    expect(notices[0]).toContain("in_progress columns skipped")
    expect(notices[1]).toContain("in_progress columns skipped")
  })

  // @failure A caller that shows no columns (post-merge's close checks, env-close's release state) must not pay for
  //          an environment read, and must see the provider's answer exactly as before.
  it("leaves a caller without an environment leg untouched", async () => {
    const root = project({ view: null })
    const notices: string[] = []
    const outcome = await runIssuesVerb({
      verb: "view",
      args: [JSON.stringify(issue("a"))],
      projectRoot: root,
      cwd: root,
      stderr: (text) => notices.push(text),
    })
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.envelope.result).toEqual({ id: "a", title: "a", status: "open", owner: "" })
    expect(notices).toEqual([])
  })

  // @failure #37838 slice 2: an issue its owner is writing to reads in progress without any environment; a write
  //          outside the 24 h window, by another seat, or to another issue does not.
  it("marks an issue in progress when its owner wrote to it inside the window", async () => {
    const now = Date.now()
    const record = (path: string, actor: string, ts: number) =>
      JSON.stringify({ seq: 1, ts, type: "node_updated", actor, source: "item-history", data: { data: { path } } })
    const journal = [
      record("@hh/tooling/37821-git-c-walks-up-to-root-repo.md", "@dev/10", now - 60_000),
      record("@hh/tooling/1-outside.md", "@dev/10", now - 25 * 60 * 60 * 1000),
      record("@hh/tooling/2-other-seat.md", "@dev/11", now - 60_000),
    ].join("\n")
    const root = project({ view: null, activity: journal })
    const read = async (key: string) => {
      const outcome = await runIssuesVerb({
        verb: "view",
        args: [key],
        projectRoot: root,
        cwd: root,
        environments: async () => [],
        stderr: () => {},
      })
      expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
      if (!outcome.ok) throw new Error(outcome.message)
      return outcome.envelope.result as PageRow
    }
    const held = await read(
      JSON.stringify({ ...issue("@hh/tooling/37821-git-c-walks-up-to-root-repo"), owner: "@dev/10" }),
    )
    expect(held.in_progress).toBe(true)
    expect(held.in_progress_reason).toMatch(/^owner @dev\/10, active \d{4}-\d{2}-\d{2}T/u)
    for (const [key, owner] of [
      ["@hh/tooling/1-outside", "@dev/10"],
      ["@hh/tooling/2-other-seat", "@dev/10"],
      ["@hh/tooling/2-other-seat", "@dev/12"],
      ["@hh/tooling/37821-git-c-walks-up-to-root-repo", ""],
    ] as const) {
      expect(await read(JSON.stringify({ ...issue(key), owner }))).toMatchObject({
        in_progress: false,
        in_progress_reason: null,
      })
    }
    expect(journal.length).toBeGreaterThan(0)
  })

  // @failure A move rewrites the path, so joining on it would lose the owner's work; the bead number survives
  //          (#37793 AC2). An open environment still wins the reason when both legs agree.
  it("joins activity across a move by bead number, and lets an environment win the reason", async () => {
    const now = Date.now()
    const moved = JSON.stringify({
      seq: 2,
      ts: now - 60_000,
      type: "node_updated",
      actor: "@dev/10",
      source: "item-history",
      data: { data: { path: "@hh/tooling/37000-old-place.md" } },
    })
    const root = project({ view: null, activity: moved })
    const read = async (key: string, holds: readonly IssuesEnvironmentHold[] = []) => {
      const outcome = await runIssuesVerb({
        verb: "view",
        args: [key],
        projectRoot: root,
        cwd: root,
        environments: async () => holds,
        stderr: () => {},
      })
      expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true)
      if (!outcome.ok) throw new Error(outcome.message)
      return outcome.envelope.result as PageRow
    }
    const afterMove = JSON.stringify({ ...issue("@hh/tooling/37000-new-place"), owner: "@dev/10" })
    expect(await read(afterMove)).toMatchObject({ in_progress: true })
    expect(await read(afterMove, [hold("env-wins", "@hh/tooling/37000-new-place", inAnHour())])).toMatchObject({
      in_progress_reason: "environment env-wins",
    })
  })
})

describe("#37838 a declared activity source that failed", () => {
  // @cto 8e7cbb99: an empty activity set says "nobody wrote", which a failed read never established. A known hold
  // still answers true; every other row says null, and the diagnostic the caller already wrote stays the only claim.
  const page = {
    rows: [
      { path: "a/1-held.md", version: "v1", row: { id: "a/1-held.md", title: "held", status: "todo", owner: "@dev/1" } },
      { path: "a/2-free.md", version: "v1", row: { id: "a/2-free.md", title: "free", status: "todo", owner: "@dev/2" } },
    ],
    next: null,
    complete: true,
  }
  const holds: IssuesEnvironmentHold[] = [{ name: "bay-one", issue: "a/1-held.md" }]

  it("reads rows as unknown, not idle, and keeps a known hold true", () => {
    const annotated = annotateInProgress("list-page", page, { holds, activityUnknown: true }, Date.now()) as Extract<
      InProgressAnnotation,
      { ok: true }
    >
    expect(annotated.ok).toBe(true)
    const rows = (annotated.result as { rows: Array<{ row: Record<string, unknown> }> }).rows
    expect(rows[0]?.row).toMatchObject({ in_progress: true, in_progress_reason: "environment bay-one" })
    expect(rows[1]?.row).toMatchObject({ in_progress: null, in_progress_reason: null })
  })

  it("still reads idle when no activity source was declared", () => {
    const annotated = annotateInProgress("list-page", page, { holds }, Date.now()) as Extract<
      InProgressAnnotation,
      { ok: true }
    >
    const rows = (annotated.result as { rows: Array<{ row: Record<string, unknown> }> }).rows
    expect(rows[1]?.row).toMatchObject({ in_progress: false, in_progress_reason: null })
  })
})
