/**
 * @failure  #38775 (@cto 0716effc, venue (a)): `yrd issues list` replayed km's journal — 22,954 rows in 32-37 s at
 *           3.9-4.3 GB RSS on /hh/pm — because the provider's one flat argv hydrates every item. The provider must be
 *           able to read km's INDEXED store instead, and the one read the callers use is `list`: a `list` entry whose
 *           provider answers with a page stream (its own `--page` request baked into the declared argv) is read as ONE
 *           traversal of ONE snapshot, with the same refusals `list-page` traverse already makes, and assembled into
 *           the one `list` answer. A provider that answers one JSON value stays byte-identical.
 * @level    l2 (a real Git repository and real provider processes)
 * @testonly none
 * @consumer the Workboard refresh · Tent's one list per pass (#38779) · the six tracker readers (#29665)
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, describe, expect, it } from "vitest"
import { ISSUES_CODES } from "../src/issues/declaration.ts"
import { runIssuesVerb } from "../src/issues/run.ts"

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

const SNAPSHOT = "a".repeat(40)

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
  return JSON.stringify(answers.map((page) => ({ snapshot: SNAPSHOT, head: 7, generation: "g1", population, ...page })))
}

/**
 * A project whose `main` declares ONE `list` entry. The page request is the provider's own — baked into the declared
 * argv, never invented by the caller — so the verb keeps its two operands-of-none contract.
 */
function project(listArgv: readonly string[]): { root: string; pageCalls: () => number } {
  const base = join(realpathSync(mkdtempSync(join(tmpdir(), "yrd-list-pages-"))), "project")
  roots.push(join(base, ".."))
  mkdirSync(base, { recursive: true })
  git(base, "init", "--quiet", "--initial-branch=main")
  writeFileSync(join(base, "issues.yml"), `list: ${JSON.stringify(listArgv)}\n`)
  git(base, "add", "-A")
  git(base, "commit", "--quiet", "-m", "seed")
  const callsLog = join(base, "..", "page-calls.log")
  return {
    root: base,
    pageCalls: () => {
      try {
        return readFileSync(callsLog, "utf8")
          .trim()
          .split("\n")
          .filter((line) => line.length > 0).length
      } catch {
        return 0
      }
    },
  }
}

/** The request the declaration bakes in: the provider's own `<page>` shape, with traversal asked for. */
const declaredPage = JSON.stringify({
  binding: "yrd-issues",
  population: "beads",
  generation: "current",
  limit: 2,
  traverse: true,
})

/** A project whose `list` argv bakes in the page request and points at a provider streaming these documents. */
function streaming(documents: readonly PageAnswer[]): { root: string; pageCalls: () => number } {
  const scratch = join(realpathSync(mkdtempSync(join(tmpdir(), "yrd-list-pages-doc-"))), "docs")
  roots.push(join(scratch, ".."))
  mkdirSync(scratch, { recursive: true })
  const pagesFile = join(scratch, "pages.json")
  writeFileSync(pagesFile, streamed(documents))
  const base = join(scratch, "..", "project")
  mkdirSync(base, { recursive: true })
  git(base, "init", "--quiet", "--initial-branch=main")
  const callsLog = join(scratch, "..", "page-calls.log")
  writeFileSync(
    join(base, "issues.yml"),
    `list: ${JSON.stringify([BUN, PROVIDER, "stream", callsLog, pagesFile, declaredPage])}\n`,
  )
  git(base, "add", "-A")
  git(base, "commit", "--quiet", "-m", "seed")
  return {
    root: base,
    pageCalls: () => {
      try {
        return readFileSync(callsLog, "utf8")
          .trim()
          .split("\n")
          .filter((line) => line.length > 0).length
      } catch {
        return 0
      }
    },
  }
}

type Outcome = Awaited<ReturnType<typeof runIssuesVerb>>

const list = (root: string): Promise<Outcome> =>
  runIssuesVerb({ verb: "list", args: [], projectRoot: root, cwd: root, stderr: () => {} })

describe("yrd issues list over a page stream", () => {
  it("reads one traversal from ONE provider process and answers the rows a flat list provider answers", async () => {
    const { root, pageCalls } = streaming([
      { rows: [row("a"), row("b")], next: "t2", complete: false },
      { rows: [row("c"), row("d")], next: "t3", complete: false },
      { rows: [row("e")], next: null, complete: true },
    ])
    const outcome = await list(root)
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
    if (!outcome.ok) return
    // @cto d233f499: `list`'s output is a contract its readers depend on, so the page envelope is unwrapped into the
    // row array a flat `list` provider already answers with - never re-shaped into a page object they do not know.
    expect(outcome.envelope.result).toEqual(["a", "b", "c", "d", "e"].map((id) => ({ id, title: id })))
    expect(pageCalls()).toBe(1)
  })

  it("refuses a traversal whose source moved between pages instead of serving two cuts", async () => {
    const { root } = streaming([
      { rows: [row("a")], next: "t2", complete: false },
      { snapshot: "b".repeat(40), rows: [row("b")], next: null, complete: true },
    ])
    const outcome = await list(root)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(ISSUES_CODES.pageSourceMoved)
    expect(outcome.message).toContain("no rows served")
  })

  it("refuses a last page that is incomplete and names no next cursor", async () => {
    const { root } = streaming([{ rows: [row("a")], next: null, complete: false }])
    const outcome = await list(root)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(ISSUES_CODES.providerInvalidResult)
    expect(outcome.message).toContain("incomplete")
  })

  it("refuses a terminal page whose population disagrees with the rows read", async () => {
    const { root } = streaming([{ population: 9, rows: [row("a")], next: null, complete: true }])
    const outcome = await list(root)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(ISSUES_CODES.providerInvalidResult)
    expect(outcome.message).toContain("population")
  })

  it("keeps a provider that answers one JSON value byte-identical", async () => {
    const { root } = project([BUN, PROVIDER, "json"])
    const outcome = await list(root)
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
    if (!outcome.ok) return
    expect(outcome.envelope.result).toEqual({ argv: [] })
    expect(outcome.stream).toBeUndefined()
  })

  it("answers ONE envelope, never a page stream, for a population that fits one page", async () => {
    const { root } = streaming([{ rows: [row("a"), row("b")], next: null, complete: true }])
    const outcome = await list(root)
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
    if (!outcome.ok) return
    expect(outcome.stream).toBeUndefined()
    expect(outcome.envelope.result).toEqual([
      { id: "a", title: "a" },
      { id: "b", title: "b" },
    ])
  })

  it("annotates the assembled rows with the in_progress columns, in the array shape list already answers", async () => {
    const { root } = streaming([
      { rows: [row("a")], next: "t2", complete: false },
      { rows: [row("b")], next: null, complete: true },
    ])
    const outcome = await runIssuesVerb({
      verb: "list",
      args: [],
      projectRoot: root,
      cwd: root,
      stderr: () => {},
      environments: async () => [
        { name: "env-a", issue: "a", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    })
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
    if (!outcome.ok) return
    expect(outcome.envelope.result).toMatchObject([
      { id: "a", in_progress: true },
      { id: "b", in_progress: false },
    ])
  })
})
