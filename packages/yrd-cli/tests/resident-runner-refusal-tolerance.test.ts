/**
 * @failure A resident queue runner dies when a peer holds the queue or withdraws a PR mid-compose, idling the whole merge queue; and its recovery echoes a bare non-loggily stderr message instead of loggily-only output.
 * @level l2
 * @consumer @yrd/cli resident runner
 */
import { describe, expect, it } from "vitest"
import { PrCheckabilityConflict } from "@yrd/bay"
import { QueueRunningConflict } from "@yrd/queue"
import { followQueueRuns } from "../src/run.ts"
import { createResponseResidentHarness as harness } from "./support/resident-harness.ts"

describe("resident runner — a busy queue never kills the watch loop (Defect 1)", () => {
  it("defers with a loud loggily warn and processes the NEXT cycle when the queue frees", async () => {
    const h = harness([
      // Cycle 1: a peer already holds the base — the compose refusal that used to
      // exit the resident (rc=1) and force an external supervisor to relaunch it.
      () => Promise.reject(new QueueRunningConflict("main", "R551")),
      // Cycle 2: the queue has freed; the runner keeps going and drains normally.
      () => {
        h.signal.aborted = true
        return Promise.resolve([])
      },
    ])

    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(0)

    // Survived the busy cycle AND reached the next interval's work.
    expect(h.runCalls()).toBe(2)
    // The defer is LOUD and typed — a structured loggily warn carrying the base + run.
    expect(h.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({ action: "resident-busy-defer", base: "main", run: "R551" }),
      }),
    )
  })

  it("still dies on a busy conflict for a one-shot targeted run — no next interval", async () => {
    // Recovery-by-defer is only for the looping resident watch. A targeted
    // `queue run PR1` propagates the refusal so the caller sees the outcome.
    const h = harness([() => Promise.reject(new QueueRunningConflict("main", "R551"))])
    await expect(followQueueRuns(h.app, ["PR1"], { interval: 1 }, h.io, h.gate)).rejects.toThrow(
      "queue 'main' is running 'R551'",
    )
    expect(h.warnings).toEqual([])
  })

  it("caps a ten-minute repeated-busy window at the first warn plus one suppressed-count summary", async () => {
    const h = harness([
      ...Array.from({ length: 61 }, () => () => Promise.reject(new QueueRunningConflict("main", "R551"))),
      () => {
        h.signal.aborted = true
        return Promise.resolve([])
      },
    ])

    await expect(followQueueRuns(h.app, [], { interval: 10 }, h.io, h.gate)).resolves.toBe(0)

    expect(h.runCalls()).toBe(62)
    expect(h.warnings).toHaveLength(2)
    expect(h.warnings[0]).toMatchObject({
      props: { action: "resident-busy-defer", base: "main", run: "R551" },
    })
    expect(h.warnings[1]).toMatchObject({
      props: { action: "resident-busy-summary", base: "main", run: "R551", suppressed: 60 },
    })
  })

  it("flushes a pending busy summary when the resident exits before a successful cycle", async () => {
    const h = harness([
      () => Promise.reject(new QueueRunningConflict("main", "R551")),
      () => {
        h.signal.aborted = true
        return Promise.reject(new QueueRunningConflict("main", "R551"))
      },
    ])

    await expect(followQueueRuns(h.app, [], { interval: 10 }, h.io, h.gate)).resolves.toBe(0)

    expect(h.warnings).toHaveLength(2)
    expect(h.warnings[1]).toMatchObject({
      props: { action: "resident-busy-summary", base: "main", run: "R551", suppressed: 1 },
    })
  })
})

describe("resident runner — a PR withdrawn mid-compose never kills the watch loop (Defect 2)", () => {
  it("skips with a loud loggily warn and processes the NEXT cycle with the remaining PRs", async () => {
    const h = harness([
      // Cycle 1: a peer withdrew a candidate PR between this runner's compose
      // snapshot and its check request — the throw that exited the resident.
      () => Promise.reject(new PrCheckabilityConflict("PR364", "withdrawn")),
      // Cycle 2: the withdrawn PR is gone from the submitted set; the remaining
      // runnable PRs compose normally, then the watch stops.
      () => {
        h.signal.aborted = true
        return Promise.resolve([])
      },
    ])

    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(0)

    expect(h.runCalls()).toBe(2)
    expect(h.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({ action: "resident-withdraw-skip", pr: "PR364", status: "withdrawn" }),
      }),
    )
  })

  it("still dies on a not-checkable refusal for a one-shot targeted run", async () => {
    const h = harness([() => Promise.reject(new PrCheckabilityConflict("PR364", "withdrawn"))])
    await expect(followQueueRuns(h.app, ["PR364"], { interval: 1 }, h.io, h.gate)).rejects.toThrow(
      "PR 'PR364' is withdrawn, not checkable",
    )
    expect(h.warnings).toEqual([])
  })

  it("skips when a PR is already integrated mid-compose (22306 #3)", async () => {
    // Multi-driver / same-runner race: PR lands between snapshot and the next
    // admit/run; "integrated, not admissible" must not kill the resident.
    const h = harness([
      () => Promise.reject(new PrCheckabilityConflict("PR1578", "integrated")),
      () => {
        h.signal.aborted = true
        return Promise.resolve([])
      },
    ])
    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(0)
    expect(h.runCalls()).toBe(2)
    expect(h.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({ action: "resident-withdraw-skip", pr: "PR1578", status: "integrated" }),
      }),
    )
  })

  it.each(["authored-gitlink", "merge-tip-carrier"] as const)(
    "skips the PR-scoped refusal %s without dying (22306 class)",
    async (code) => {
      // @ci 2026-07-25: a single PR's authored-gitlink killed the whole resident.
      // Architectural acceptance: any PR-scoped refusal is a cycle skip, not exit 1.
      const { createFailure } = await import("@yrd/core")
      const h = harness([
        () =>
          Promise.reject(
            createFailure({
              kind: "refusal",
              code,
              message:
                "yrd: PR 'PR1579' changes generated-only gitlinks [km]; authored root carriers use 'yrd pr create <branch>'",
            }),
          ),
        () => {
          h.signal.aborted = true
          return Promise.resolve([])
        },
      ])
      await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(0)
      expect(h.runCalls()).toBe(2)
      expect(h.warnings).toContainEqual(
        expect.objectContaining({
          props: expect.objectContaining({ action: "resident-pr-refusal-skip", code }),
        }),
      )
      expect(h.stderr.join("")).toBe("")
    },
  )
})

describe("resident runner — tolerated skips are loggily-only (Defect 3)", () => {
  it("emits NO bare 'yrd:' stderr echo when it defers a busy cycle", async () => {
    const h = harness([
      () => Promise.reject(new QueueRunningConflict("main", "R551")),
      () => {
        h.signal.aborted = true
        return Promise.resolve([])
      },
    ])
    await followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)
    // Loud via the structured log stream…
    expect(h.warnings.length).toBeGreaterThan(0)
    // …and NOT duplicated as a bare human-readable stderr echo in resident mode.
    expect(h.stderr.join("")).toBe("")
  })

  it("emits NO bare 'yrd:' stderr echo when it skips a withdrawn-PR cycle", async () => {
    const h = harness([
      () => Promise.reject(new PrCheckabilityConflict("PR364", "withdrawn")),
      () => {
        h.signal.aborted = true
        return Promise.resolve([])
      },
    ])
    await followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)
    expect(h.stderr.join("")).toBe("")
  })
})
