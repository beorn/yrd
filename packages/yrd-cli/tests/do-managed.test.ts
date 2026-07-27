// @failure The managed `do` composition drives its stages out of order, runs a remedy the carrier's state refuses, or returns without naming the stage that stopped it.
// @level l2
// @consumer @yrd/cli

import { describe, expect, it, vi } from "vitest"
import { createFailure } from "@yrd/core"
import {
  managedDoRequested,
  resolveManagedDoPlan,
  runManagedDo,
  type ManagedDoConfig,
  type ManagedDoDelivery,
  type ManagedDoLock,
  type ManagedDoStages,
} from "../src/do-managed.ts"

const ISSUE = "@yrd/core/22398"
const LANE = "@dev/0"
const BRANCH = "yrd/22398"
const BAY = "bay-22398"
const CARRIER = "PR42"
const LANDED = "a".repeat(40)

const CONFIG: ManagedDoConfig = {
  lane: LANE,
  assign: { run: "tent assign" },
  launch: { run: "hab up" },
  pollMs: 1_000,
  carrierTimeoutMs: 5_000,
  landingTimeoutMs: 5_000,
}

function plan(config: ManagedDoConfig = CONFIG) {
  return resolveManagedDoPlan({ do: config, base: "main" })
}

type Recorded = Readonly<{ calls: string[]; notes: string[] }>

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
  let clock = 0
  const heads = [...(overrides.heads ?? ["b".repeat(40)])]
  const deliveries = [...(overrides.deliveries ?? [{ state: "integrated", landingSha: LANDED, findings: [] }])]
  const forbidden = { queueRun: vi.fn(), prReady: vi.fn(), prSubmit: vi.fn() }
  const base: ManagedDoStages = {
    assign: async (input) => {
      calls.push(`assign:${input.issue}:${input.lane}`)
    },
    openBay: async (input) => {
      calls.push(`bay:${input.issue}`)
      return { bay: BAY, branch: BRANCH, path: `/bays/${BAY}`, headSha: "0".repeat(40) }
    },
    launch: async (input) => {
      calls.push(`launch:${input.bay}:${input.lane}`)
    },
    observeCarrier: async () => {
      calls.push("carrier")
      const head = heads.length > 1 ? heads.shift() : heads[0]
      return head === undefined ? {} : { headSha: head }
    },
    createDraft: async (input) => {
      calls.push(`draft:${input.branch}:${input.issue}`)
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
    note: (text) => {
      notes.push(text)
    },
  }
  const { heads: _heads, deliveries: _deliveries, ...stageOverrides } = overrides
  return { stages: { ...base, ...stageOverrides }, recorded: { calls, notes }, forbidden }
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
    expect(() => resolveManagedDoPlan({ do: { lane: LANE, assign: { run: "x" } }, base: "main" })).toThrow(
      /do\.launch/u,
    )
  })

  it("names the config file in the refusal so the operator knows where to write the key", () => {
    expect(() => resolveManagedDoPlan({ base: "main" })).toThrow(/\.yrd\.yml/u)
  })

  it("defaults the bounded wait to 45 minutes and the poll interval to 30 seconds", () => {
    const resolved = resolveManagedDoPlan({
      do: { lane: LANE, assign: { run: "a" }, launch: { run: "l" } },
      base: "main",
    })
    expect(resolved.settings.carrierTimeoutMs).toBe(45 * 60_000)
    expect(resolved.settings.landingTimeoutMs).toBe(45 * 60_000)
    expect(resolved.settings.pollMs).toBe(30_000)
  })
})

describe("managed do composition", () => {
  it("drives assign, bay, launch, carrier, draft, recut, observe in order and proves the landing", async () => {
    const { stages, recorded, forbidden } = createStages()
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })

    expect(result.outcome).toBe("landed")
    expect(result.stage).toBe("observe")
    expect(result.landingSha).toBe(LANDED)
    expect(result.ancestry).toBe(`git merge-base --is-ancestor ${LANDED} origin/main`)
    expect(result.trail).toMatchObject({ issue: ISSUE, lane: LANE, bay: BAY, branch: BRANCH, carrier: CARRIER })
    expect(recorded.calls).toEqual([
      `assign:${ISSUE}:${LANE}`,
      `bay:${ISSUE}`,
      `launch:${BAY}:${LANE}`,
      "carrier",
      `draft:${BRANCH}:${ISSUE}`,
      `recut:${CARRIER}:preflight`,
      `recut:${CARRIER}:queue`,
      "observe",
    ])
    expect(forbidden.queueRun).not.toHaveBeenCalled()
    expect(forbidden.prReady).not.toHaveBeenCalled()
    expect(forbidden.prSubmit).not.toHaveBeenCalled()
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

  it("names the launch stage and surfaces the child's output", async () => {
    const { stages } = createStages({
      launch: async () => {
        throw failure("launch-refused", "launch exited 2: no declaration for @dev/0")
      },
    })
    const result = await runManagedDo({ issue: ISSUE, plan: plan(), stages, lock: FREE_LOCK })
    expect(result).toMatchObject({ outcome: "refused", stage: "launch" })
    expect(result.reason).toContain("no declaration for @dev/0")
    expect(result.trail.bay).toBe(BAY)
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
