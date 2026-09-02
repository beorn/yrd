/**
 * @failure A one-shot `yrd queue run` answers SIGTERM/SIGINT with the default
 *          disposition: no drain, no settle of the run in flight, no distinct
 *          exit code. The run stays `in_progress` and the next pass has to
 *          recover a row nobody recorded a reason for.
 * @level   l2
 * @consumer @yrd/cli `queue run --once` · `queue run <PR>` · Hab supervision
 *
 * Measured 2026-09-01, three deaths of the same shape in one day: a peer's
 * SIGTERM to a running pass, an account rotation that took the parent shell,
 * and a stopped agent loop whose kill walked the process tree into the pass.
 * Each left a job unfinished; a later pass then re-lost it.
 *
 * The root was one omission — `host.ts` minted the drain AbortController for
 * `habitant-queue-run` and `bracketed-bay-open` and left `one-shot-queue-run`
 * out — so `io.drainSignal` was undefined on exactly the posture an operator
 * runs by hand, every cooperative drain check on that path was inert, and the
 * boundary treated the FIRST signal as the hard one.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createExclusive } from "@yrd/persistence"
import { bindProcessShutdown, type ShutdownProcess } from "../src/host.ts"
import {
  HABITANT_EXIT,
  HABITANT_EXIT_DISPOSITION,
  HABITANT_STAND_DOWN_EXIT_CODES,
  habitantExitCondition,
} from "../src/habitant-exit.ts"
import {
  QUEUE_DRAIN_EXIT,
  QUEUE_DRAIN_REASON_CODE,
  closeDrainedQueuePass,
  drainedQueuePassExit,
  queueDrainReason,
  queuePostureDrains,
  settleDrainedQueuePass,
} from "../src/queue-drain.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-drain-"))
  roots.push(root)
  return root
}

type LogCall = Readonly<{ message: string; props?: Record<string, unknown> }>

function recordingLog() {
  const infos: LogCall[] = []
  const errors: LogCall[] = []
  return {
    infos,
    errors,
    log: {
      info: (message: string, props?: Record<string, unknown>) => infos.push({ message, props }),
      error: (message: string, props?: Record<string, unknown>) => errors.push({ message, props }),
    },
  }
}

/**
 * A queue journal small enough to read in one screen and honest about the two
 * facts the drain turns on: a run's terminal state, and its members' submit
 * facts. `recover` is the ONLY verb that moves anything — every verdict verb is
 * present and counts its calls, so a drain that reached one would be visible
 * rather than merely absent from an assertion.
 */
function modelledQueue(runner: string) {
  const open = (id: string, held: string) => ({
    id,
    runner: held,
    status: "in_progress",
    conclusion: undefined as string | undefined,
    reason: undefined as string | undefined,
  })
  const runs = [open("R7", runner), open("R8", "yrd-cli:other")]
  const members = [{ id: "PR31", run: "R7", delivery: "submitted" }]
  const verdictVerbs: string[] = []
  const recoverCalls: Readonly<{ recoveryTime: string; runner: string; reason: string }>[] = []
  const queue = {
    recover: async (options: Readonly<{ recoveryTime: string; runner: string; reason: string }>) => {
      recoverCalls.push(options)
      const settled = runs.filter((run) => run.runner === options.runner && run.status === "in_progress")
      for (const run of settled) {
        run.status = "completed"
        run.conclusion = "canceled"
        run.reason = options.reason
      }
      return settled.map((run) => ({ id: run.id }))
    },
    // Present so a drain that took a verdict path would be caught, not merely
    // unasserted. None of these may fire: the pass was killed, it never judged
    // the content, so the author's submit fact has to stand.
    rejectChange: async () => void verdictVerbs.push("rejectChange"),
    cancelRun: async () => void verdictVerbs.push("cancelRun"),
    finishAdmission: async () => void verdictVerbs.push("finishAdmission"),
  }
  return { queue, runs, members, verdictVerbs, recoverCalls }
}

function fakeProcess() {
  const handlers = new Map<string, Set<() => void>>()
  const kills: Readonly<{ pid: number; signal: string }>[] = []
  const runtime: ShutdownProcess = {
    pid: 4242,
    on: (event, handler) => {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
    },
    off: (event, handler) => void handlers.get(event)?.delete(handler),
    kill: (pid, signal) => void kills.push({ pid, signal }),
  }
  return {
    runtime,
    kills,
    listeners: (event: string) => handlers.get(event)?.size ?? 0,
    raise: (event: "SIGINT" | "SIGTERM") => {
      for (const handler of [...(handlers.get(event) ?? [])]) handler()
    },
  }
}

describe("a one-shot queue pass drains on a signal instead of dying mid-job", () => {
  it("arms a drain for the posture an operator runs by hand, not just the supervised one", () => {
    // The defect, stated as the assertion that would have caught it. The other
    // two were never in doubt; `one-shot-queue-run` is the row that was missing,
    // and it is the posture `yrd queue run --once` and `yrd queue run <PR>` both
    // resolve to.
    expect(queuePostureDrains("one-shot-queue-run")).toBe(true)
    expect(queuePostureDrains("habitant-queue-run")).toBe(true)
    expect(queuePostureDrains("bracketed-bay-open")).toBe(true)
    // A verb that is not a writing pass owns no signal disposition.
    expect(queuePostureDrains("command")).toBe(false)
  })

  it("settles the run in flight to a TERMINAL state carrying a coded reason", async () => {
    const model = modelledQueue("yrd-cli:9931")
    const { log, infos } = recordingLog()

    const settlement = await settleDrainedQueuePass(model.queue, "yrd-cli:9931", "SIGTERM", log)

    // The whole defect in one assertion: the row this pass held is no longer
    // `in_progress`, and it says WHY in a form a reader can key on.
    const held = model.runs.find((run) => run.id === "R7")
    expect(held?.status).toBe("completed")
    expect(held?.status).not.toBe("in_progress")
    expect(held?.conclusion).toBe("canceled")
    expect(held?.reason).toContain(QUEUE_DRAIN_REASON_CODE)
    expect(held?.reason).toBe(queueDrainReason("SIGTERM"))
    expect(settlement).toMatchObject({ runs: ["R7"], bounded: false, failed: false })

    // Runner-scoped, so a pass stopping itself never settles a peer's live run.
    expect(model.recoverCalls).toHaveLength(1)
    expect(model.recoverCalls[0]).toMatchObject({ runner: "yrd-cli:9931" })
    expect(model.runs.find((run) => run.id === "R8")?.status).toBe("in_progress")

    // Loud, and naming what it settled — a silent settle is a row nobody knows
    // moved.
    expect(infos.map((call) => call.props?.action)).toContain("queue-drain-settled")
  })

  it("leaves the affected member's submit fact standing, and reaches no verdict verb", async () => {
    const model = modelledQueue("yrd-cli:9931")
    const { log } = recordingLog()

    await settleDrainedQueuePass(model.queue, "yrd-cli:9931", "SIGTERM", log)

    // The pass was killed; it never judged the content. Marking the run
    // verdictless is the correct record, and the author's submit fact must
    // survive it so the change re-queues on the next pass.
    expect(model.members.map((member) => member.delivery)).toEqual(["submitted"])
    expect(model.verdictVerbs).toEqual([])
    expect(queueDrainReason("SIGTERM")).toContain("no verdict was reached")
  })

  it("reports loudly and exits anyway when the settle outruns its bound", async () => {
    const { log, errors } = recordingLog()
    const queue = { recover: () => new Promise<readonly { id: string }[]>(() => undefined) }

    const settlement = await settleDrainedQueuePass(queue, "yrd-cli:9931", "SIGTERM", log, {
      ms: 5,
      sleep: async () => undefined,
    })

    // Bounded: a drain that cannot finish is still a stop, never a hang.
    expect(settlement).toMatchObject({ bounded: true })
    expect(errors.map((call) => call.props?.action)).toContain("queue-drain-bound-expired")
    expect(errors[0]?.props).toMatchObject({ runner: "yrd-cli:9931", signal: "SIGTERM" })
  })

  it("releases the lease on the drain path, and the next pass takes it immediately", async () => {
    const stateDir = await scratch()
    const model = modelledQueue("yrd-cli:9931")
    const { log } = recordingLog()
    const order: string[] = []

    // The real thing: the same flock the host takes for a queue runner lease.
    const released = Promise.withResolvers<void>()
    const acquired = Promise.withResolvers<void>()
    const held = createExclusive(join(stateDir, "resident-runner"), { timeoutMs: 0 }).run(async () => {
      acquired.resolve()
      await released.promise
    }, { holder: "queue=q epoch=e mode=once" })
    await Promise.race([acquired.promise, held])

    // A DRAIN reaches the boundary's close with no signal argument — the pass
    // ran to its own end. On the code this replaces that path settled nothing.
    await closeDrainedQueuePass({
      stopped: "SIGTERM",
      settle: async (signal) => {
        order.push("settle")
        await settleDrainedQueuePass(model.queue, "yrd-cli:9931", signal, log)
      },
      close: async () => {
        order.push("release")
        released.resolve()
        await held
      },
    })

    // Settle BEFORE release: the reverse lets the next pass start against a
    // queue this one is still writing.
    expect(order).toEqual(["settle", "release"])
    expect(model.runs.find((run) => run.id === "R7")?.status).toBe("completed")

    // The proof the lease actually came off: a second pass takes it now, with
    // no dead-pid retry beat in between.
    const second = Promise.withResolvers<void>()
    const secondAcquired = Promise.withResolvers<void>()
    const secondHeld = createExclusive(join(stateDir, "resident-runner"), { timeoutMs: 0 }).run(async () => {
      secondAcquired.resolve()
      await second.promise
    }, { holder: "queue=q epoch=e2 mode=once" })
    await Promise.race([secondAcquired.promise, secondHeld])
    second.resolve()
    await secondHeld
  })

  it("releases the lease even when the settle itself fails", async () => {
    const { log, errors } = recordingLog()
    const order: string[] = []

    await closeDrainedQueuePass({
      stopped: "SIGINT",
      settle: async (signal) => {
        order.push("settle")
        // A settle that throws must not cost the release: this path runs while
        // the process is already leaving, so losing the lease release here is
        // how the NEXT pass fails to start at all.
        const outcome = await settleDrainedQueuePass(
          { recover: () => Promise.reject(new Error("journal is locked")) },
          "yrd-cli:9931",
          signal,
          log,
        )
        expect(outcome).toMatchObject({ failed: true })
      },
      close: async () => void order.push("release"),
    })

    expect(order).toEqual(["settle", "release"])
    expect(errors.map((call) => call.props?.action)).toContain("queue-drain-settle-failed")
  })
})

describe("the two-phase signal contract at the CLI boundary", () => {
  it("asks on the first signal and TAKES on the second", async () => {
    const runtime = fakeProcess()
    const drains: string[] = []
    const shutdowns: string[] = []

    const finish = bindProcessShutdown(
      async (signal) => void shutdowns.push(signal),
      (signal) => void drains.push(signal),
      undefined,
      runtime.runtime,
    )

    // Phase one ASKS: the command keeps running, nothing is closed.
    runtime.raise("SIGTERM")
    expect(drains).toEqual(["SIGTERM"])
    expect(shutdowns).toEqual([])

    // Phase two TAKES, promptly — the host closes on the signal itself, not on
    // whatever the still-running pass does next.
    runtime.raise("SIGTERM")
    await Promise.resolve()
    expect(shutdowns).toEqual(["SIGTERM"])
    expect(drains).toEqual(["SIGTERM"])

    // And the native exit status stays honest: the signal is re-raised once the
    // boundary has unwound, with the handlers removed first so it is not caught.
    finish()
    expect(runtime.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }])
    expect(runtime.listeners("SIGTERM")).toBe(0)
    expect(runtime.listeners("SIGINT")).toBe(0)
  })

  it("escalates itself at the bound when no second signal ever comes", async () => {
    const runtime = fakeProcess()
    const shutdowns: string[] = []
    const expired: string[] = []

    const finish = bindProcessShutdown(
      async (signal) => void shutdowns.push(signal),
      () => undefined,
      { ms: 1, onExpire: (signal) => void expired.push(signal) },
      runtime.runtime,
    )

    runtime.raise("SIGINT")
    expect(shutdowns).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))

    // A drain waits on work it does not control, so without this a "graceful"
    // stop and a hung one are the same observation.
    expect(expired).toEqual(["SIGINT"])
    expect(shutdowns).toEqual(["SIGINT"])
    finish()
    expect(runtime.kills).toEqual([{ pid: 4242, signal: "SIGINT" }])
  })

  it("treats every signal as the hard one when a posture drains nothing", async () => {
    const runtime = fakeProcess()
    const shutdowns: string[] = []

    // A plain verb owns no in-flight queue work, so the FIRST signal closes it —
    // the behaviour a one-shot queue pass wrongly shared until this change.
    const finish = bindProcessShutdown(
      async (signal) => void shutdowns.push(signal),
      undefined,
      undefined,
      runtime.runtime,
    )
    runtime.raise("SIGTERM")
    await Promise.resolve()
    expect(shutdowns).toEqual(["SIGTERM"])
    finish()
  })
})

describe("the exit code a drained pass leaves", () => {
  it("is distinct from a clean pass, an ordinary failure, and a hard interrupt", () => {
    expect(QUEUE_DRAIN_EXIT).toBe(HABITANT_EXIT.drained)
    for (const other of [0, 1, 2, HABITANT_EXIT.interrupted]) expect(QUEUE_DRAIN_EXIT).not.toBe(other)
    // Clear of the generic verb alphabet, like every other lifecycle condition.
    expect(QUEUE_DRAIN_EXIT).toBeGreaterThan(3)
  })

  it("is documented in the taxonomy every other exit code is declared in", () => {
    // Not a constant beside the table but a row IN it: `habitantExitCondition`
    // is what a supervisor reads, and a code the table does not carry comes
    // back `undefined` — "we do not know", printed at 2am.
    expect(habitantExitCondition(QUEUE_DRAIN_EXIT)).toBe("drained")
    expect(HABITANT_EXIT_DISPOSITION.drained).toBe("stand-down")
    // Restarting a pass a person deliberately stopped undoes their request.
    expect(HABITANT_STAND_DOWN_EXIT_CODES).toContain(QUEUE_DRAIN_EXIT)
  })

  it("chooses one answer per way of stopping, so the three cannot drift apart", () => {
    // Nobody stopped it: the work's own verdict stands, success or failure.
    expect(drainedQueuePassExit(0, {})).toBe(0)
    expect(drainedQueuePassExit(1, {})).toBe(1)
    // Drained on purpose.
    expect(drainedQueuePassExit(0, { drained: "SIGTERM" })).toBe(QUEUE_DRAIN_EXIT)
    // A hard signal cut it short with work outstanding — the contract every
    // non-habitant caller already speaks, and it outranks the drain that
    // preceded it.
    expect(drainedQueuePassExit(0, { hard: "SIGINT" })).toBe(HABITANT_EXIT.interrupted)
    expect(drainedQueuePassExit(0, { drained: "SIGTERM", hard: "SIGINT" })).toBe(HABITANT_EXIT.interrupted)
  })

  it("is the ONE-SHOT's code, and leaves the supervised runner's clean-drain 0 alone", () => {
    // Same event, opposite correct answers, and the difference is who is
    // listening. A one-shot's exit status reaches an operator or the script
    // that ran it, so a drain must not read as "finished". The resident runs
    // under `hab restart=on-failure`, where the same 16 would be a failure and
    // would restart the runner a person just stopped — its clean drain is
    // specified as 0 (D3, `queue-cancel.test.ts`). The caller passes `drained`
    // only for the one-shot; this pins that the helper does not decide it.
    expect(drainedQueuePassExit(0, {})).toBe(0)
    expect(drainedQueuePassExit(0, { drained: "SIGTERM" })).not.toBe(0)
  })
})
