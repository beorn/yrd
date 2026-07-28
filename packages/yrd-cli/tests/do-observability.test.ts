/**
 * @failure `yrd do` runs its whole composition without emitting one log event, so an operator watching a managed dispatch cannot tell which phase it is in, which phase stopped it, or how long any of them took.
 * @level l2
 * @consumer @yrd/cli operators running `yrd do`
 */
import { describe, expect, it } from "vitest"
import { YRD_LIFECYCLE_LEVELS } from "@yrd/core"
import { createLogger, type Event } from "loggily"
import {
  MANAGED_DO_STAGES,
  resolveManagedDoPlan,
  runManagedDo,
  type ManagedDoConfig,
  type ManagedDoDelivery,
  type ManagedDoLock,
  type ManagedDoStageBoundary,
  type ManagedDoStages,
} from "../src/do-managed.ts"
import { managedDoBoundaryLevel, observeManagedDo } from "../src/do-observability.ts"

const ISSUE = "@yrd/core/22477"
const LANE = "@dev/0"
const BRANCH = "task/22477"
const BAY = "B242"
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

const FREE_LOCK: ManagedDoLock = { acquire: async () => ({ release: async () => undefined }) }

type LogEvent = Extract<Event, { kind: "log" }>

type Observed = Readonly<{
  events: readonly LogEvent[]
  journalled: readonly ManagedDoStageBoundary[]
}>

/** Drive the real composition over stage doubles, with the real boundary
 * observer wrapping a journal that only records. `deliveries` decides where the
 * run ends: the default lands, a caller can refuse instead. */
async function driveManagedDo(overrides: Partial<ManagedDoStages> = {}): Promise<Observed> {
  const events: Event[] = []
  const log = createLogger("yrd", [{ level: "trace", spans: false }, { write: (event: Event) => events.push(event) }])
  const journalled: ManagedDoStageBoundary[] = []
  let clock = 0
  let wallClock = 0
  const delivery: ManagedDoDelivery = { state: "integrated", landingSha: LANDED, findings: [] }
  const stages: ManagedDoStages = {
    assign: async () => undefined,
    decideSeat: async () => undefined,
    openBay: async () => ({ bay: BAY, branch: BRANCH, path: `/bays/${BAY}`, headSha: "0".repeat(40) }),
    launch: async () => undefined,
    closeBay: async () => undefined,
    observeCarrier: async () => ({ headSha: "b".repeat(40) }),
    createDraft: async () => ({ pr: CARRIER }),
    recut: async () => undefined,
    observeDelivery: async () => delivery,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    wallNow: () => new Date(Date.UTC(2026, 6, 27, 17, 0, wallClock++)),
    recordBoundary: observeManagedDo(log, async (boundary) => {
      journalled.push(boundary as ManagedDoStageBoundary)
    }),
    ...overrides,
  }
  await runManagedDo({ issue: ISSUE, plan: resolveManagedDoPlan({ do: CONFIG, base: "main" }), stages, lock: FREE_LOCK })
  log.end()
  return {
    events: events.filter((event): event is LogEvent => event.kind === "log"),
    journalled,
  }
}

function story(events: readonly LogEvent[]): readonly string[] {
  return events
    .filter((event) => event.level === "info" && event.namespace.startsWith("yrd:do:"))
    .map((event) => `${String(event.props?.stage)} ${String(event.props?.outcome)}`)
}

describe("managed do phase story", () => {
  it("emits one INFO start and one INFO completion for every stage, in composition order", async () => {
    const { events } = await driveManagedDo()

    // DERIVED, not enumerated: the expectation is generated from the same
    // ordered stage list `drive` runs, so adding a stage to the composition
    // without giving it a phase boundary fails here instead of landing silent.
    expect(story(events)).toEqual(MANAGED_DO_STAGES.flatMap((stage) => [`${stage} started`, `${stage} succeeded`]))
  })

  it("names each stage with its own namespace so one phase can be isolated", async () => {
    const { events } = await driveManagedDo()
    const namespaces = new Set(events.filter((event) => event.namespace.startsWith("yrd:do")).map((e) => e.namespace))
    expect([...namespaces].sort()).toEqual(MANAGED_DO_STAGES.map((stage) => `yrd:do:${stage}`).sort())
  })

  it("carries the trail an operator needs to act: issue, lane, Bay, branch and carrier", async () => {
    const { events } = await driveManagedDo()
    const observed = events.findLast((event) => event.namespace === "yrd:do:observe")
    expect(observed?.props).toMatchObject({
      issue: ISSUE,
      lane: LANE,
      stage: "observe",
      bay: BAY,
      branch: BRANCH,
      carrier: CARRIER,
    })
  })

  it("times every completed stage", async () => {
    const { events } = await driveManagedDo()
    const completions = events.filter(
      (event) => event.namespace.startsWith("yrd:do:") && event.props?.outcome === "succeeded",
    )
    expect(completions).toHaveLength(MANAGED_DO_STAGES.length)
    for (const completion of completions) expect(completion.props?.durationMs).toBeTypeOf("number")
  })

  it("reports a stage refusal with the reason, at the level the rest of Yrd uses", async () => {
    const { events } = await driveManagedDo({
      launch: async () => {
        throw new Error("hab up: no free slot")
      },
    })

    const refusal = events.findLast((event) => event.namespace === "yrd:do:launch")
    expect(refusal?.props).toMatchObject({ stage: "launch", outcome: "refused" })
    expect(String(refusal?.props?.reason)).toContain("no free slot")
    // Severity is NOT a local policy: it comes from the one lifecycle table, so
    // a do refusal cannot drift away from every other Yrd refusal.
    expect(refusal?.level).toBe(YRD_LIFECYCLE_LEVELS.refused)
    // The composition stopped at launch; nothing downstream may claim to run.
    expect(story(events)).not.toContain("draft started")
  })

  it("stops the story where the composition stopped, without inventing later stages", async () => {
    const { events } = await driveManagedDo({
      openBay: async () => {
        throw new Error("bay pool exhausted")
      },
    })
    expect(story(events)).toEqual([
      "concurrency started",
      "concurrency succeeded",
      "assign started",
      "assign succeeded",
      "seat started",
      "seat succeeded",
      "bay started",
      // The story ENDS on the refusal that ended the run — the last line an
      // operator reads names the stage that stopped, never a silent stop.
      "bay refused",
    ])
  })
})

describe("managed do observation is observation", () => {
  it("leaves the durable journal receiving exactly the boundaries the driver emitted", async () => {
    const { events, journalled } = await driveManagedDo()
    // The JSONL journal is the composition's durable trail; wrapping it for logs
    // must not add, drop, or reorder a single boundary.
    expect(journalled.map((boundary) => `${boundary.stage} ${boundary.phase}`)).toEqual(
      MANAGED_DO_STAGES.flatMap((stage) => [`${stage} started`, `${stage} completed`]),
    )
    expect(events.filter((event) => event.namespace.startsWith("yrd:do:"))).toHaveLength(journalled.length)
  })

  it("propagates a journal failure instead of hiding it behind a successful log line", async () => {
    const log = createLogger("yrd", [{ level: "silent" }])
    const journal = observeManagedDo(log, async () => {
      throw new Error("disk full")
    })
    await expect(
      journal({
        issue: ISSUE,
        lane: LANE,
        stage: "assign",
        phase: "started",
        trail: { issue: ISSUE, lane: LANE },
      }),
    ).rejects.toThrow("disk full")
    log.end()
  })

  it("maps every boundary phase onto a severity, with starts promoted to the milestone level", () => {
    expect(managedDoBoundaryLevel("started")).toBe("info")
    expect(managedDoBoundaryLevel("completed")).toBe(YRD_LIFECYCLE_LEVELS.succeeded)
    expect(managedDoBoundaryLevel("refused")).toBe(YRD_LIFECYCLE_LEVELS.refused)
    expect(managedDoBoundaryLevel("timed-out")).toBe(YRD_LIFECYCLE_LEVELS.failed)
  })
})
