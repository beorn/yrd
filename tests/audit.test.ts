import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createBay, createJsonlJournal, definePlugin, makeEvent, pipe, withWorkspaces } from "../src/index.ts"
import type { BayRuntime, BayStore } from "../src/index.ts"
import { formatAudit, withAudit, type AuditFinding } from "../src/layers/audit.ts"
import { git } from "../src/layers/git.ts"

const TS = "2024-01-01T00:00:00.000Z"
const CLOCK = () => TS
const ACTOR = "tester"

function openStore(path: string): BayStore {
  return { journal: createJsonlJournal(path), close: async () => {} }
}

async function tmpJournalPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-audit-"))
  return join(dir, "journal.jsonl")
}

describe("formatAudit", () => {
  it("renders the exact clean line the happy-path doc asserts", () => {
    expect(formatAudit([])).toBe(
      "bay: clean — no strays, no unreachable pins, no refs without a name",
    )
  })

  it("renders one law-7 line per finding (kind: subject — detail. Fix: remedy)", () => {
    const findings: AuditFinding[] = [
      { kind: "stray", subject: "task/x", detail: "d1", remedy: "r1" },
      { kind: "unreachable-pin", subject: "vendor/s", detail: "d2", remedy: "r2" },
      { kind: "unnamed-ref", subject: "bay/y", detail: "d3", remedy: "r3" },
    ]
    expect(formatAudit(findings)).toBe(
      [
        "bay: stray: task/x — d1. Fix: r1",
        "bay: unreachable-pin: vendor/s — d2. Fix: r2",
        "bay: unnamed-ref: bay/y — d3. Fix: r3",
      ].join("\n"),
    )
  })
})

// Stub audit.run shadows the real (git-touching) handler — registered FIRST so
// core's `.find(Boolean)` over layers in registration order picks it. Lets the
// reducer→effect→event flow be tested with no git at all.
const withStubAudit = definePlugin({
  name: "stub-audit",
  effects: {
    "audit.run": async (effect, bay) => {
      const mainRepo = (effect.data as { mainRepo: string | null }).mainRepo
      return [makeEvent(bay, "audit.completed", { findings: [], clean: true, echoed: mainRepo })]
    },
  },
})

async function buildStubAuditBay(path: string): Promise<BayRuntime> {
  return pipe(
    createBay({ store: openStore(path), clock: CLOCK, actor: ACTOR }),
    withStubAudit, // first → shadows the real audit.run
    withAudit(),
  )
}

describe("withAudit — reducer emits a read-only audit.run effect", () => {
  it("passes an inline mainRepo through to the effect (no events, one completed row)", async () => {
    const bay = await buildStubAuditBay(await tmpJournalPath())
    const { events } = await bay.dispatch({ type: "audit", args: { mainRepo: "/repo/x" } })
    const done = events.find((e) => e.type === "audit.completed")!
    expect(done.data!.echoed).toBe("/repo/x")
    expect(done.data!.clean).toBe(true)
  })

  it("defaults mainRepo to null when omitted (handler resolves it ambiently)", async () => {
    const bay = await buildStubAuditBay(await tmpJournalPath())
    const { events } = await bay.dispatch({ type: "audit" })
    expect(events.find((e) => e.type === "audit.completed")!.data!.echoed).toBeNull()
  })

  it("throws on a blank mainRepo", async () => {
    const bay = await buildStubAuditBay(await tmpJournalPath())
    await expect(bay.dispatch({ type: "audit", args: { mainRepo: "  " } })).rejects.toThrow(
      /'mainRepo'.*non-empty/,
    )
  })
})

// Real-git integration, gated so the default suite stays hermetic (BAY_GIT_TESTS=1).
async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "gitbay-audit-realgit-"))
  for (const args of [
    ["-C", repo, "init", "-q"],
    ["-C", repo, "config", "user.email", "test@example.com"],
    ["-C", repo, "config", "user.name", "test"],
    ["-C", repo, "config", "commit.gpgsign", "false"],
  ]) {
    expect((await git(args)).code).toBe(0)
  }
  await writeFile(join(repo, "README.md"), "hi\n")
  expect((await git(["-C", repo, "add", "-A"])).code).toBe(0)
  expect((await git(["-C", repo, "commit", "-q", "-m", "init"])).code).toBe(0)
  return repo
}

async function appendEndedLease(
  journalPath: string,
  branch: string,
  endReason: "merged" | "abandoned",
): Promise<void> {
  const journal = createJsonlJournal(journalPath)
  await journal.append({
    v: 1, ts: TS, actor: ACTOR, type: "lease.opened", lease: "L1", pr: "C-x",
    data: { lease: "L1", bay: 1, workitem: "wi-x", changeId: "C-x", branch },
  })
  await journal.append({
    v: 1, ts: TS, actor: ACTOR, type: "lease.ended", lease: "L1", pr: "C-x",
    data: { lease: "L1", endReason },
  })
}

describe.skipIf(!process.env.BAY_GIT_TESTS)("withAudit — real git", () => {
  it("reports clean when the ended lease's branch is on the mainline and no stray refs exist", async () => {
    const repo = await initRepo()
    try {
      // A branch pointing AT HEAD is reachable from the mainline → merged, not stray.
      expect((await git(["-C", repo, "branch", "task/merged-x"])).code).toBe(0)
      const journalPath = join(repo, "journal.jsonl")
      await appendEndedLease(journalPath, "task/merged-x", "merged")

      const bay = pipe(
        createBay({ store: openStore(journalPath), clock: CLOCK, actor: ACTOR }),
        withWorkspaces(),
        withAudit(),
      )
      const { events } = await bay.dispatch({ type: "audit", args: { mainRepo: repo } })
      const done = events.find((e) => e.type === "audit.completed")!
      expect(done.data!.clean).toBe(true)
      expect(done.data!.findings).toEqual([])
      expect(formatAudit(done.data!.findings as AuditFinding[])).toBe(
        "bay: clean — no strays, no unreachable pins, no refs without a name",
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("flags a stray abandoned branch AND an orphan task/* ref (no worktree)", async () => {
    const repo = await initRepo()
    try {
      const base = (await git(["-C", repo, "symbolic-ref", "--short", "HEAD"])).stdout.trim()

      // A divergent, unmerged branch that an abandoned lease points at → stray.
      expect((await git(["-C", repo, "checkout", "-q", "-b", "task/stray-x"])).code).toBe(0)
      await writeFile(join(repo, "stray.txt"), "work\n")
      expect((await git(["-C", repo, "add", "-A"])).code).toBe(0)
      expect((await git(["-C", repo, "commit", "-q", "-m", "stray work"])).code).toBe(0)
      expect((await git(["-C", repo, "checkout", "-q", base])).code).toBe(0)

      // A task/* branch with NO backing worktree → unnamed-ref.
      expect((await git(["-C", repo, "branch", "task/orphan-y"])).code).toBe(0)

      const journalPath = join(repo, "journal.jsonl")
      await appendEndedLease(journalPath, "task/stray-x", "abandoned")

      const bay = pipe(
        createBay({ store: openStore(journalPath), clock: CLOCK, actor: ACTOR }),
        withWorkspaces(),
        withAudit(),
      )
      const { events } = await bay.dispatch({ type: "audit", args: { mainRepo: repo } })
      const findings = events.find((e) => e.type === "audit.completed")!.data!.findings as AuditFinding[]

      expect(findings.find((f) => f.kind === "stray")?.subject).toBe("task/stray-x")
      expect(findings.find((f) => f.kind === "unnamed-ref")?.subject).toBe("task/orphan-y")
      // task/stray-x is a task/* branch too, but it is backed by lease L1 → not double-flagged.
      expect(findings.filter((f) => f.subject === "task/stray-x")).toHaveLength(1)
      expect(findings.every((f) => f.remedy.length > 0)).toBe(true) // law 7
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
