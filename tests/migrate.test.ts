import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createGitbay, createJsonlJournal, pipe, submittedPrs, withQueue, withWorktrees } from "../src/index.ts"
import { migrateJournal } from "../src/migrate.ts"

/**
 * The v1 journal this fixture represents — a small but representative slice
 * of a real bay's history, hand-authored in the pre-v0.3 dotted-name shape
 * (spec § event schema v2, "the journal migration"):
 *
 *   1. init
 *   2. open "alpha" (L1/wt1, pre-mints PR1) — real push later merges it
 *   3. open "beta" (L2/wt2, pre-mints PR2) — closed before ever pushing
 *   4. beta's push-that-never-happened: nothing (PR2 stays a phantom mint)
 *   5. alpha pushes: pr.opened is skipped (a LEASE already owns the branch —
 *      the receiver's OWN pr id, PR1, is used directly) → checking → merged
 *   6. beta closes (abandoned) before any push — L2/wt2 freed
 *   7. a legacy branch adopted directly (no lease) → PR3, queued
 *   8. PR3 integrates and gets rejected (a red check)
 */
const TS = (n: number): string => `2024-01-0${n}T00:00:00.000Z`

type V1Line = Record<string, unknown>

function v1Fixture(): V1Line[] {
  return [
    { v: 1, ts: TS(1), actor: "tester", type: "bay.initialized", data: { repo: "/repo/x/bay/repo.git", journal: "/repo/x/bay/journal.jsonl", store: "sqlite" } },

    // open alpha (L1 → wt1 → PR1)
    { v: 1, ts: TS(1), actor: "tester", type: "lease.opened", lease: "L1", pr: "PR1", data: { lease: "L1", bay: 1, workitem: "alpha", changeId: "PR1", branch: "task/alpha" } },
    { v: 1, ts: TS(1), actor: "tester", type: "workspace.provisioned", lease: "L1", data: { lease: "L1", path: "/repo/x/.bays/wt1", baseSha: "a".repeat(40), headSha: "a".repeat(40) } },

    // open beta (L2 → wt2 → PR2), then close it before any push
    { v: 1, ts: TS(1), actor: "tester", type: "lease.opened", lease: "L2", pr: "PR2", data: { lease: "L2", bay: 2, workitem: "beta", changeId: "PR2", branch: "task/beta" } },
    { v: 1, ts: TS(1), actor: "tester", type: "workspace.provisioned", lease: "L2", data: { lease: "L2", path: "/repo/x/.bays/wt2", baseSha: "a".repeat(40), headSha: "a".repeat(40) } },
    { v: 1, ts: TS(2), actor: "tester", type: "lease.ended", lease: "L2", pr: "PR2", data: { lease: "L2", endReason: "abandoned" } },
    { v: 1, ts: TS(2), actor: "tester", type: "workspace.retired", lease: "L2", data: { lease: "L2", path: "/repo/x/.bays/wt2", abandonedRef: "refs/bay/abandoned/PR2" } },

    // alpha's push: the receiver's FIRST push for a lease-tracked PR still
    // emits pr.opened (state.prs has no row yet — only state.leases does,
    // via lease.opened) before the queued → checking transition.
    { v: 1, ts: TS(2), actor: "tester", type: "pr.opened", pr: "PR1", data: { pr: "PR1", target: "task/alpha", name: "alpha" } },
    { v: 1, ts: TS(2), actor: "tester", type: "pr.state-changed", pr: "PR1", data: { pr: "PR1", from: "queued", to: "checking" } },
    { v: 1, ts: TS(2), actor: "tester", type: "pr.state-changed", pr: "PR1", data: { pr: "PR1", from: "checking", to: "merging" } },
    { v: 1, ts: TS(2), actor: "tester", type: "pr.state-changed", pr: "PR1", data: { pr: "PR1", from: "merging", to: "merged", detail: "merged deadbeef onto main" } },
    { v: 1, ts: TS(2), actor: "tester", type: "lease.ended", lease: "L1", pr: "PR1", data: { lease: "L1", endReason: "merged" } },

    // a legacy branch adopted directly (no lease) → PR3, queued
    { v: 1, ts: TS(3), actor: "tester", type: "pr.opened", pr: "PR3", data: { pr: "PR3", target: "legacy/gamma", name: "gamma" } },
    { v: 1, ts: TS(3), actor: "tester", type: "adopt.recorded", pr: "PR3", data: { branch: "legacy/gamma", pr: "PR3", name: "gamma" } },

    // PR3 integrates and is rejected by a red check
    { v: 1, ts: TS(3), actor: "tester", type: "pr.state-changed", pr: "PR3", data: { pr: "PR3", from: "queued", to: "merging" } },
    {
      v: 1,
      ts: TS(3),
      actor: "tester",
      type: "pr.state-changed",
      pr: "PR3",
      data: { pr: "PR3", from: "merging", to: "rejected", detail: "exit 1: boom" },
    },

    // non-events that must be dropped, not migrated
    { v: 1, ts: TS(3), actor: "tester", type: "queue.empty" },
    { v: 1, ts: TS(3), actor: "tester", type: "gc.clean", data: { checked: 0, expired: 0, ttlMs: 2700000 } },
  ]
}

async function makeV1Dir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-migrate-"))
  const body = v1Fixture()
    .map((l) => JSON.stringify(l))
    .join("\n")
  await writeFile(join(dir, "journal.jsonl"), body + "\n", "utf8")
  return dir
}

async function makeCurrentV1Dir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-migrate-"))
  const body = v1Fixture()
    .map((l) => JSON.stringify(l))
    .join("\n")
  await writeFile(join(dir, "events.jsonl"), body + "\n", "utf8")
  return dir
}

/** The equivalent shape a v1 fold would have produced for THIS fixture —
 *  computed by hand (not by re-running removed v1 code) since that is exactly
 *  what "no dual-read shim" rules out; this is the fixture's ground truth,
 *  asserted directly against both the pre- and post-migration readings. */
const EXPECTED = {
  leases: {
    L1: { workitem: "alpha", branch: "task/alpha", changeId: "PR1", path: "/repo/x/.bays/wt1", ended: true, endReason: "merged" },
    L2: { workitem: "beta", branch: "task/beta", changeId: "PR2", path: "/repo/x/.bays/wt2", ended: true, endReason: "abandoned" },
  },
  prs: {
    PR1: { name: "alpha", state: "merged", revision: 1 },
    PR3: { name: "gamma", state: "rejected", revision: 1 },
  },
}

describe("migrateJournal — v1 → v2", () => {
  it("renames every event, drops the two non-events, and backs up the original", async () => {
    const dir = await makeV1Dir()
    const { migrated, dropped } = await migrateJournal(dir)

    // Dropped = queue.empty + gc.clean (non-events) + adopt.recorded (absorbed
    // into pr/opened's `via` — nothing left for it to carry).
    expect(dropped).toBe(3)
    expect(migrated).toBe(v1Fixture().length - dropped)

    // The v1 file is preserved verbatim alongside, never overwritten.
    expect(existsSync(join(dir, "journal.v1.jsonl"))).toBe(true)
    const backup = await readFile(join(dir, "journal.v1.jsonl"), "utf8")
    expect(backup.trim().split("\n")).toHaveLength(v1Fixture().length)

    const migratedLines = (await readFile(join(dir, "journal.jsonl"), "utf8")).trim().split("\n")
    expect(migratedLines).toHaveLength(migrated)
    for (const line of migratedLines) {
      const event = JSON.parse(line)
      expect(event).toHaveProperty("id")
      expect(event).toHaveProperty("cause.commandId")
      expect(event).not.toHaveProperty("v")
      expect(event).not.toHaveProperty("type") // renamed field is `name`
      expect(event).not.toHaveProperty("actor") // dropped from the envelope; bay/opened carries it in `data` instead
    }
  })

  it("refuses a second migration once journal.v1.jsonl already exists", async () => {
    const dir = await makeV1Dir()
    await migrateJournal(dir)
    await expect(migrateJournal(dir)).rejects.toThrow(/already exists/)
  })

  it("migrates the current events.jsonl path and backs it up as events.v1.jsonl", async () => {
    const dir = await makeCurrentV1Dir()
    const { migrated, backupPath } = await migrateJournal(dir)

    expect(migrated).toBe(v1Fixture().length - 3)
    expect(backupPath).toBe(join(dir, "events.v1.jsonl"))
    expect(existsSync(join(dir, "events.v1.jsonl"))).toBe(true)
    expect(existsSync(join(dir, "journal.v1.jsonl"))).toBe(false)

    const migratedLines = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n")
    expect(migratedLines).toHaveLength(migrated)
  })

  it("event names are the v2 slash-namespaced families, in order, adopt.recorded absorbed", async () => {
    const dir = await makeV1Dir()
    await migrateJournal(dir)
    const journal = createJsonlJournal(join(dir, "journal.jsonl"))
    const names: string[] = []
    for await (const e of journal.replay()) names.push(e.name)

    expect(names).toEqual([
      "gitbay/initialized",
      "bay/opened", // alpha
      "worktree/provisioned",
      "bay/opened", // beta
      "worktree/provisioned",
      "bay/closed", // beta closes
      "worktree/deprovisioned",
      "pr/opened", // alpha's first push, via: push
      "pr/changed", // alpha: queued → checking
      "pr/changed", // → merging
      "pr/changed", // → merged
      "bay/closed", // alpha's lease ends (merged)
      "pr/opened", // gamma, via: submit
      "pr/changed", // → merging
      "pr/changed", // → rejected
    ])
  })

  it("infers pr/opened's via correctly: 'push' when a lease pre-minted the PR, 'submit' otherwise", async () => {
    // alpha's PR1 was pre-minted by lease.opened before its pr.opened row →
    // "push". gamma's PR3 is a bare adopt with no lease → "submit".
    const dir = await makeV1Dir()
    await migrateJournal(dir)
    const journal = createJsonlJournal(join(dir, "journal.jsonl"))
    const opened: Record<string, string> = {}
    for await (const e of journal.replay()) {
      if (e.name === "pr/opened") opened[e.data.pr as string] = e.data.via as string
    }
    expect(opened).toEqual({ PR1: "push", PR3: "submit" })
  })

  it("rejected pr/changed rows get an inferred code; endReason maps to via", async () => {
    const dir = await makeV1Dir()
    await migrateJournal(dir)
    const journal = createJsonlJournal(join(dir, "journal.jsonl"))
    const events: { name: string; data: Record<string, unknown> }[] = []
    for await (const e of journal.replay()) events.push(e as never)

    const rejected = events.find((e) => e.name === "pr/changed" && e.data.to === "rejected")!
    expect(rejected.data.code).toBe("merge-command-failed") // "exit 1: boom" matches no specific pattern

    const betaClosed = events.filter((e) => e.name === "bay/closed").find((e) => e.data.bay === "L2")!
    expect(betaClosed.data.via).toBe("close") // endReason "abandoned" → via "close"
    const alphaClosed = events.filter((e) => e.name === "bay/closed").find((e) => e.data.bay === "L1")!
    expect(alphaClosed.data.via).toBe("merged")
  })

  it("renames the pre-model.md PR state vocabulary: queued→submitted, checking/merging/merged/rejected unchanged", async () => {
    // The blind spot this closes: PR1's and PR3's FINAL states (merged,
    // rejected) happen to be unrenamed names, so a bug that let old "queued"/
    // "open"/"abandoned" leak through unrenamed would still pass every OTHER
    // assertion in this file — only the INTERMEDIATE from/to values prove the
    // rename actually ran.
    const dir = await makeV1Dir()
    await migrateJournal(dir)
    const journal = createJsonlJournal(join(dir, "journal.jsonl"))
    const transitions: string[] = []
    for await (const e of journal.replay()) {
      if (e.name !== "pr/changed") continue
      const d = e.data as { pr: string; from: string; to: string }
      transitions.push(`${d.pr}: ${d.from}→${d.to}`)
    }
    expect(transitions).toEqual([
      "PR1: submitted→checking", // was queued→checking
      "PR1: checking→merging",
      "PR1: merging→merged",
      "PR3: submitted→merging", // was queued→merging
      "PR3: merging→rejected",
    ])
  })

  it("replay of the migrated journal through the REAL v2 layers reconstructs the fixture's ground truth", async () => {
    const dir = await makeV1Dir()
    await migrateJournal(dir)

    const bay = pipe(
      createGitbay({ store: { journal: createJsonlJournal(join(dir, "journal.jsonl")), close: async () => {} } }),
      withWorktrees({ mainRepo: dir }),
      withQueue(),
    )
    const state = await bay.state()

    for (const [id, expected] of Object.entries(EXPECTED.leases)) {
      const lease = state.leases[id]!
      expect(lease, id).toBeDefined()
      expect(lease.workitem, id).toBe(expected.workitem)
      expect(lease.branch, id).toBe(expected.branch)
      expect(lease.changeId, id).toBe(expected.changeId)
      expect(lease.path, id).toBe(expected.path)
      expect(lease.endedAt !== undefined, id).toBe(expected.ended)
      expect(lease.endReason, id).toBe(expected.endReason)
    }

    for (const [id, expected] of Object.entries(EXPECTED.prs)) {
      const pr = state.prs[id]!
      expect(pr, id).toBeDefined()
      expect(pr.name, id).toBe(expected.name)
      expect(pr.state, id).toBe(expected.state)
      expect(pr.revision, id).toBe(expected.revision)
    }

    // The queue slice still knows PR3's target — modulo the NEW `via` field
    // nothing about the queue-facing shape regressed.
    expect(submittedPrs(state)).toEqual([]) // PR3 is rejected, not submitted
  })
})
