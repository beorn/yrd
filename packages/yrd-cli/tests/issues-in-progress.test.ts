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

/** A one-repository project whose `main` declares the given verbs, each answered with a fixed payload. */
function project(payloads: Readonly<Record<string, unknown>>): string {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "yrd-in-progress-"))), "project")
  roots.push(join(root, ".."))
  mkdirSync(root, { recursive: true })
  git(root, "init", "--quiet", "--initial-branch=main")
  const declaration = Object.keys(payloads)
    .map((verb) => `${verb}: ${JSON.stringify([BUN, PROVIDER, "reply", `<${verb === "view" ? "key" : "page"}>`])}`)
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
})
