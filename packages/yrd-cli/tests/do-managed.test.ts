// @failure The managed `do` composition drives its stages out of order, runs a remedy the carrier's state refuses, or returns without naming the stage that stopped it.
// @level l2
// @consumer @yrd/cli

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createFailure } from "@yrd/core"
import {
  createManagedDoJournal,
  createManagedDoScoreboard,
  formatManagedDoTimingTable,
  managedDoRequested,
  resolveManagedDoPlan,
  runManagedDo,
  type ManagedDoConfig,
  type ManagedDoDelivery,
  type ManagedDoLock,
  type ManagedDoStageBoundary,
  type ManagedDoStages,
} from "../src/do-managed.ts"
import { observeManagedDoDelivery } from "../src/run.ts"
import type { YrdCliApp } from "../src/types.ts"

const ISSUE = "@yrd/core/22398"
const LANE = "@dev/0"
const BRANCH = "yrd/22398"
const BAY = "bay-22398"
const CARRIER = "PR42"
const LANDED = "a".repeat(40)

const CONFIG: ManagedDoConfig = {
  lane: LANE,
  assign: { run: "tent assign" },
  seat: { run: "tent seat-recycle" },
  launch: { run: "hab up" },
  pollMs: 1_000,
  carrierTimeoutMs: 5_000,
  landingTimeoutMs: 5_000,
}

function plan(config: ManagedDoConfig = CONFIG) {
  return resolveManagedDoPlan({ do: config, base: "main" })
}

type Recorded = Readonly<{ calls: string[]; notes: string[]; boundaries: ManagedDoStageBoundary[] }>

type StageOverrides = Partial<ManagedDoStages> &
  Readonly<{
    heads?: readonly (string | undefined)[]
    deliveries?: readonly ManagedDoDelivery[]
  }>

/** Stage doubles plus the verbs the managed path must NEVER reach for. The
 * forbidden spies are attached to the same object so a future contract that
 * grows one of them fails this suite instead of landing quietly. */
function createStages(overrides: StageOverrides = {}): {
  stages: ManagedDoStages
  recorded: Recorded
  forbidden: {
    queueRun: ReturnType<typeof vi.fn>
    prReady: ReturnType<typeof vi.fn>
    prSubmit: ReturnType<typeof vi.fn>
  }
} {
  const calls: string[] = []
  const notes: string[] = []
  const boundaries: ManagedDoStageBoundary[] = []
  let clock = 0
  let wallClock = 0
  const heads = [...(overrides.heads ?? ["b".repeat(40)])]
  const deliveries = [...(overrides.deliveries ?? [{ state: "integrated", landingSha: LANDED, findings: [] }])]
  const forbidden = { queueRun: vi.fn(), prReady: vi.fn(), prSubmit: vi.fn() }
  const base: ManagedDoStages = {
    assign: async (input) => {
      calls.push(`assign:${input.issue}:${input.lane}`)
    },
    decideSeat: async (input) => {
      calls.push(`seat:${input.issue}:${input.lane}`)
    },
    openBay: async (input) => {
      calls.push(`bay:${input.issue}`)
      return { bay: BAY, branch: BRANCH, path: `/bays/${BAY}`, headSha: "0".repeat(40) }
    },
    launch: async (input) => {
      calls.push(`launch:${input.bay}:${input.lane}`)
    },
    closeBay: async (input) => {
      calls.push(`close:${input.bay}`)
    },
    observeCarrier: async () => {
      calls.push("carrier")
      const head = heads.length > 1 ? heads.shift() : heads[0]
      return head === undefined ? {} : { headSha: head }
    },
    createDraft: async (input) => {
      calls.push(`draft:${input.branch}:${input.issue}:track=${String(input.track)}`)
      return { pr: CARRIER }
    },
    recut: async (input) => {
      calls.push(`recut:${input.pr}:${input.preflight ? "preflight" : "queue"}`)
    },
    observeDelivery: async () => {
      calls.push("observe")
      const delivery = deliveries.length > 1 ? deliveries.shift() : deliveries[0]
      if (delivery === undefined) throw new Error("test stage ran out of deliveries")
      return delivery
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    wallNow: () => new Date(Date.UTC(2026, 6, 27, 17, 0, wallClock++)),
    recordBoundary: async (boundary) => {
      boundaries.push(boundary)
    },
    note: (text) => {
      notes.push(text)
    },
  }
  const { heads: _heads, deliveries: _deliveries, ...stageOverrides } = overrides
  return { stages: { ...base, ...stageOverrides }, recorded: { calls, notes, boundaries }, forbidden }
}

const FREE_LOCK: ManagedDoLock = {
  acquire: async () => ({ release: async () => undefined }),
}

function failure(code: string, message: string): Error {
  return createFailure({ kind: "refusal", code, message })
}

/** The live 22396 specimen shape: only a message carrying both pins projects
 * the escalation branch. */
const GITLINK_CONFLICT =
  "yrd: PR 'PR42' cannot be recut: target root 'aaa1112223334445556667778889990001112223' " +
  "pins submodule 'vendor/km' to 'base2223334445556667778889990001112223334', while the " +
  "replayed authored root 'ccc3334445556667778889990001112223334445' pins it to " +
  "'auth4445556667778889990001112223334445556'"

describe("managed do mode gate", () => {
  it("takes the managed path when --seat is explicit or the host reports no terminal", () => {
    expect(managedDoRequested({ seat: true }, { interactive: true })).toBe(true)
    expect(managedDoRequested({}, { interactive: false })).toBe(true)
    expect(managedDoRequested({}, { interactive: true })).toBe(false)
  })

  it("leaves an embedded caller that states nothing about a terminal on the interactive path", () => {
    // The process host always states `interactive`; only an API caller omits it,
    // and it must not be flipped into an unattended composition by silence.
    expect(managedDoRequested({}, {})).toBe(false)
  })
})

describe("managed do configuration", () => {
  it("refuses by name for every missing key", () => {
    expect(() => resolveManagedDoPlan({ base: "main" })).toThrow(/do\.lane/u)
    expect(() => resolveManagedDoPlan({ do: { lane: LANE }, base: "main" })).toThrow(/do\.assign/u)
    expect(() => resolveManagedDoPlan({ do: { lane: LANE, assign: { run: "x" } }, base: "main" })).toThrow(/do\.seat/u)
    expect(() =>
      resolveManagedDoPlan({ do: { lane: LANE, assign: { run: "x" }, seat: { run: "s" } }, base: "main" }),
    ).toThrow(/do\.launch/u)
  })

  it("names the config file in the refusal so the operator knows where to write the key", () => {
    expect(() => resolveManagedDoPlan({ base: "main" })).toThrow(/\.yrd\.yml/u)
  })

  it("takes the lane from --lane, falls back to the configured default, and refuses when neither states one", () => {
    expect(resolveManagedDoPlan({ do: CONFIG, base: "main" }, { lane: "@dev/7" }).settings.lane).toBe("@dev/7")
    expect(resolveManagedDoPlan({ do: CONFIG, base: "main" }, {}).settings.lane).toBe(LANE)
    const laneless: ManagedDoConfig = { ...CONFIG, lane: undefined }
    expect(resolveManagedDoPlan({ do: laneless, base: "main" }, { lane: "@dev/7" }).settings.lane).toBe("@dev/7")
    expect(() => resolveManagedDoPlan({ do: laneless, base: "main" })).toThrow(/--lane or \.yrd\.yml key 'do\.lane'/u)
  })

  it("refuses an empty --lane instead of falling back to the configured default", () => {
    expect(() => resolveManagedDoPlan({ do: CONFIG, base: "main" }, { lane: "   " })).toThrow(
      /--lane requires a persona identity/u,
    )
  })

  it("tracks the managed carrier by default and only stops when the repository says so", () => {
    expect(resolveManagedDoPlan({ do: CONFIG, base: "main" }).settings.track).toBe(true)
    expect(resolveManagedDoPlan({ do: { ...CONFIG, track: false }, base: "main" }).settings.track).toBe(false)
  })

  it("defaults the bounded wait to 45 minutes and the poll interval to 30 seconds", () => {
    const resolved = resolveManagedDoPlan({
      do: { lane: LANE, assign: { run: "a" }, seat: { run: "s" }, launch: { run: "l" } },
      base: "main",
    })
    expect(resolved.settings.carrierTimeoutMs).toBe(45 * 60_000)
    expect(resolved.settings.landingTimeoutMs).toBe(45 * 60_000)
    expect(resolved.settings.pollMs).toBe(30_000)
  })
})

describe("managed do composition", () => {
  it("decides the seat before opening a Bay, timestamps every stage boundary, and proves the landing", async () => {
    const { stages, recorded, forbidden } = createStages()
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })

    expect(result.outcome).toBe("landed")
    expect(result.stage).toBe("observe")
    expect(result.landingSha).toBe(LANDED)
    expect(result.ancestry).toBe(`git merge-base --is-ancestor ${LANDED} origin/main`)
    expect(result.trail).toMatchObject({ issue: ISSUE, lane: LANE, bay: BAY, branch: BRANCH, carrier: CARRIER })
    expect(result.timings).toHaveLength(9)
    expect(result.timings.map(({ stage, phase, durationMs }) => ({ stage, phase, durationMs }))).toEqual([
      { stage: "concurrency", phase: "completed", durationMs: 1_000 },
      { stage: "assign", phase: "completed", durationMs: 1_000 },
      { stage: "seat", phase: "completed", durationMs: 1_000 },
      { stage: "bay", phase: "completed", durationMs: 1_000 },
      { stage: "launch", phase: "completed", durationMs: 1_000 },
      { stage: "carrier", phase: "completed", durationMs: 1_000 },
      { stage: "draft", phase: "completed", durationMs: 1_000 },
      { stage: "recut", phase: "completed", durationMs: 1_000 },
      { stage: "observe", phase: "completed", durationMs: 1_000 },
    ])
    expect(result).toMatchObject({
      startedAt: "2026-07-27T17:00:00.000Z",
      endedAt: "2026-07-27T17:00:17.000Z",
      durationMs: 17_000,
    })
    expect(recorded.calls).toEqual([
      `assign:${ISSUE}:${LANE}`,
      `seat:${ISSUE}:${LANE}`,
      `bay:${ISSUE}`,
      `launch:${BAY}:${LANE}`,
      "carrier",
      `draft:${BRANCH}:${ISSUE}:track=true`,
      `recut:${CARRIER}:preflight`,
      `recut:${CARRIER}:queue`,
      "observe",
    ])
    expect(recorded.boundaries.map(({ stage, phase }) => `${stage}:${phase}`)).toEqual([
      "concurrency:started",
      "concurrency:completed",
      "assign:started",
      "assign:completed",
      "seat:started",
      "seat:completed",
      "bay:started",
      "bay:completed",
      "launch:started",
      "launch:completed",
      "carrier:started",
      "carrier:completed",
      "draft:started",
      "draft:completed",
      "recut:started",
      "recut:completed",
      "observe:started",
      "observe:completed",
    ])
    expect(recorded.boundaries.every(({ at }) => /^2026-07-27T17:00:\d{2}\.000Z$/u.test(at))).toBe(true)
    expect(forbidden.queueRun).not.toHaveBeenCalled()
    expect(forbidden.prReady).not.toHaveBeenCalled()
    expect(forbidden.prSubmit).not.toHaveBeenCalled()
  })

  it("cuts a TRACKED carrier so a seat's next push re-records itself instead of waiting for a human", async () => {
    const { stages, recorded } = createStages()
    await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(recorded.calls).toContain(`draft:${BRANCH}:${ISSUE}:track=true`)
  })

  it("honors a repository that opted its managed carriers out of tracking", async () => {
    const { stages, recorded } = createStages()
    await runManagedDo({ issue: ISSUE, plan: plan({ ...CONFIG, track: false }), stages, lock: FREE_LOCK })
    expect(recorded.calls).toContain(`draft:${BRANCH}:${ISSUE}:track=false`)
  })

  it("cuts the draft before the first recut", async () => {
    const { stages, recorded } = createStages()
    await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    const draft = recorded.calls.findIndex((call) => call.startsWith("draft:"))
    const recut = recorded.calls.findIndex((call) => call.startsWith("recut:"))
    expect(draft).toBeGreaterThanOrEqual(0)
    expect(recut).toBeGreaterThan(draft)
  })

  it("waits for a head that advanced past the bay's lease base before cutting anything", async () => {
    const { stages, recorded } = createStages({ heads: ["0".repeat(40), "0".repeat(40), "c".repeat(40)] })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result.outcome).toBe("landed")
    expect(recorded.calls.filter((call) => call === "carrier")).toHaveLength(3)
  })
})

describe("managed do delivery observation", () => {
  it("refreshes the durable projection before classifying a resident landing", async () => {
    const pushed = {
      id: CARRIER,
      state: "open",
      merged: false,
      revs: [{ n: 1, head: "b".repeat(40), pushedAt: "2026-07-27T18:00:00.000Z" }],
    }
    const landed = {
      ...pushed,
      state: "closed",
      merged: true,
      integratedAt: "2026-07-27T18:01:00.000Z",
      integration: { commit: LANDED, baseSha: "c".repeat(40) },
    }
    let current = pushed
    const refresh = vi.fn(async () => {
      current = landed
      return {}
    })
    const app = {
      refresh,
      bays: { pr: () => current },
      queue: { audit: () => ({ findings: [] }) },
    } as unknown as YrdCliApp

    await expect(observeManagedDoDelivery(app, CARRIER)).resolves.toEqual({
      state: "integrated",
      landingSha: LANDED,
      findings: [],
    })
    expect(refresh).toHaveBeenCalledOnce()
  })
})

describe("managed do refusals", () => {
  it("names the assign stage and keeps the trail", async () => {
    const { stages } = createStages({
      assign: async () => {
        throw failure("assign-refused", "assign command exited 1")
      },
    })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "refused", stage: "assign" })
    expect(result.reason).toContain("assign command exited 1")
    expect(result.trail).toMatchObject({ issue: ISSUE, lane: LANE })
  })

  it("names the bay stage", async () => {
    const { stages } = createStages({
      openBay: async () => {
        throw failure("bay-refused", "bay could not be provisioned")
      },
    })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "refused", stage: "bay" })
  })

  it("refuses a seat decision before opening a Bay", async () => {
    const { stages, recorded } = createStages({
      decideSeat: async () => {
        throw failure("seat-refused", "live incumbent could not be recycled")
      },
    })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "refused", stage: "seat" })
    expect(result.reason).toContain("could not be recycled")
    expect(result.trail.bay).toBeUndefined()
    expect(recorded.calls).toEqual([`assign:${ISSUE}:${LANE}`])
    expect(recorded.boundaries.at(-1)).toMatchObject({ stage: "seat", phase: "refused" })
  })

  it("closes the exact fresh Bay when launch refuses and surfaces the child's output", async () => {
    const { stages, recorded } = createStages({
      launch: async () => {
        throw failure("launch-refused", "launch exited 2: no declaration for @dev/0")
      },
    })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "refused", stage: "launch" })
    expect(result.reason).toContain("no declaration for @dev/0")
    expect(result.trail.bay).toBe(BAY)
    expect(recorded.calls).toEqual([`assign:${ISSUE}:${LANE}`, `seat:${ISSUE}:${LANE}`, `bay:${ISSUE}`, `close:${BAY}`])
    expect(recorded.boundaries.at(-1)).toMatchObject({ stage: "launch", phase: "refused" })
  })

  it("times out at the carrier stage with the bay in the trail", async () => {
    const { stages } = createStages({ heads: ["0".repeat(40)] })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "timed-out", stage: "carrier" })
    expect(result.trail).toMatchObject({ bay: BAY, branch: BRANCH })
    expect(result.trail.carrier).toBeUndefined()
  })

  it("times out at the observe stage with the carrier in the trail", async () => {
    const { stages } = createStages({ deliveries: [{ state: "submitted", findings: [] }] })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "timed-out", stage: "observe" })
    expect(result.trail.carrier).toBe(CARRIER)
  })

  it("refuses at observe when the queue audit reports an admission refusal loop", async () => {
    const { stages } = createStages({
      deliveries: [
        {
          state: "submitted",
          findings: [{ code: "admission-refusal-loop", message: "PR42 refused 3 times at admission", count: 3 }],
        },
      ],
    })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "refused", stage: "observe" })
    expect(result.reason).toContain("admission-refusal-loop")
  })

  it("refuses at observe when the carrier is rejected", async () => {
    const { stages } = createStages({ deliveries: [{ state: "rejected", findings: [] }] })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "refused", stage: "observe" })
    expect(result.reason).toContain("rejected")
  })

  it("refuses rather than reporting a landing without a SHA", async () => {
    const { stages } = createStages({ deliveries: [{ state: "integrated", findings: [] }] })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "refused", stage: "observe" })
    expect(result.landingSha).toBeUndefined()
  })
})

describe("managed do boundary journal", () => {
  it("appends schema-1 wall-clock stage boundaries under the managed-do state directory", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "yrd-do-journal-"))
    try {
      const journal = createManagedDoJournal({
        stateDir,
        now: () => new Date("2026-07-27T17:08:20.724Z"),
      })
      await journal({
        issue: ISSUE,
        lane: LANE,
        stage: "seat",
        phase: "completed",
        trail: { issue: ISSUE, lane: LANE },
      })

      const rows = (await readFile(join(stateDir, "do-managed", "journal.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown)
      expect(rows).toEqual([
        {
          schema: 1,
          at: "2026-07-27T17:08:20.724Z",
          issue: ISSUE,
          lane: LANE,
          stage: "seat",
          phase: "completed",
          trail: { issue: ISSUE, lane: LANE },
        },
      ])
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it("prints exact stage durations and appends one durable scoreboard row per terminal run", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "yrd-do-scoreboard-"))
    try {
      const { stages } = createStages()
      const first = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
      const append = createManagedDoScoreboard({ stateDir })
      await append(first)
      await append({ ...first, durationMs: 12_000, endedAt: "2026-07-27T17:00:12.000Z" })

      const table = formatManagedDoTimingTable(first)
      expect(table).toContain("STAGE")
      expect(table).toContain("assign")
      expect(table).toContain("1.000s")
      expect(table).toContain("TOTAL")

      const rows = (await readFile(join(stateDir, "do-managed", "scoreboard.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        schema: 1,
        issue: ISSUE,
        lane: LANE,
        outcome: "landed",
        durationMs: 17_000,
        timings: expect.arrayContaining([
          expect.objectContaining({ stage: "concurrency", phase: "completed", durationMs: 1_000 }),
        ]),
      })
      expect(rows[1]).toMatchObject({ schema: 1, durationMs: 12_000 })
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})

describe("managed do remedies", () => {
  it("stops at the named stage when the failure carries an escalation", async () => {
    let recuts = 0
    const { stages } = createStages({
      recut: async () => {
        recuts += 1
        throw failure("recut-gitlink-conflict", GITLINK_CONFLICT)
      },
    })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "refused", stage: "recut" })
    expect(result.escalation).toContain("judgment")
    // The escalation recipe is guidance for a human, never a step the driver runs.
    expect(recuts).toBe(1)
  })

  it("never runs a remedy step outside the managed verb set", async () => {
    // A submitted carrier's state-aware remedy opens with `pr submit`, which the
    // managed path is not allowed to run (draft-then-recut only).
    const { stages } = createStages({
      recut: async () => {
        throw failure("authored-gitlink", "PR 'PR42' authored a gitlink; submitted revisions cannot be recut")
      },
      deliveries: [{ state: "submitted", findings: [] }],
    })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "refused", stage: "recut" })
    expect(result.remedy?.join(" ")).toContain("yrd pr submit")
    expect(result.reason).toContain("managed")
  })

  it("follows a state-aware remedy that stays inside the managed verb set", async () => {
    let recuts = 0
    const drafts: string[] = []
    const { stages } = createStages({
      createDraft: async (input) => {
        drafts.push(input.branch)
        return { pr: CARRIER }
      },
      recut: async () => {
        recuts += 1
        // A draft (pushed) carrier's remedy is `pr create` + `recut --preflight
        // --queue`: both inside the managed verb set.
        if (recuts === 1) throw failure("authored-gitlink", "PR 'PR42' authored a gitlink; recut the draft revision")
      },
      deliveries: [
        { state: "pushed", findings: [] },
        { state: "integrated", landingSha: LANDED, findings: [] },
      ],
    })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result.outcome).toBe("landed")
    expect(drafts).toHaveLength(2)
    expect(recuts).toBeGreaterThan(2)
  })
})

describe("managed do concurrency", () => {
  it("refuses to start while another managed run holds the marker", async () => {
    const lock: ManagedDoLock = {
      acquire: async () => ({ holder: { pid: 4321, issue: "@yrd/core/22000", startedAt: "2026-07-26T10:00:00.000Z" } }),
    }
    const { stages, recorded } = createStages()
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock })
    expect(result).toMatchObject({ outcome: "refused", stage: "concurrency" })
    expect(result.reason).toContain("4321")
    expect(result.reason).toContain("@yrd/core/22000")
    expect(recorded.calls).toEqual([])
  })

  it("reclaims a stale marker loudly and proceeds", async () => {
    const lock: ManagedDoLock = {
      acquire: async () => ({
        reclaimed: { pid: 999, issue: "@yrd/core/21000", startedAt: "2026-07-26T09:00:00.000Z" },
        release: async () => undefined,
      }),
    }
    const { stages, recorded } = createStages()
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock })
    expect(result.outcome).toBe("landed")
    expect(recorded.notes.join("")).toContain("999")
  })

  it("releases the marker on every exit path", async () => {
    const release = vi.fn(async () => undefined)
    const lock: ManagedDoLock = { acquire: async () => ({ release }) }
    const { stages } = createStages({
      assign: async () => {
        throw failure("assign-refused", "nope")
      },
    })
    await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock })
    expect(release).toHaveBeenCalledTimes(1)
  })
})
