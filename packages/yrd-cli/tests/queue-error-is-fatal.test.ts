/**
 * @failure A queue pass that reported an ERROR-level row carried on past it and
 *          exited 0 or 1 like any other pass: the log said one thing and the
 *          exit status another, and a resident could sit on a standing ERROR
 *          for hours while every instrument read it as healthy.
 * @level   l2
 * @consumer @yrd/cli `queue run` (resident and `--once`) · Hab supervision
 *
 * Operator ruling 2026-09-01, verbatim: "if the queue ERRORs without quitting
 * we should fix that — any ERROR should result in it dying." So an ERROR row
 * is a stop cause, entering the SAME drain a signal enters: admissions close,
 * the job in flight settles with a coded reason, the lease releases, and the
 * process exits `fatal-error` (17) after a terminal line naming the row.
 */
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger, type LogEvent } from "loggily"
import {
  bindProcessShutdown,
  createYrdHost as createYrdHostRaw,
  runYrdProcess,
  type ShutdownProcess,
} from "../src/host.ts"
import {
  HABITANT_EXIT,
  HABITANT_EXIT_DISPOSITION,
  HABITANT_STAND_DOWN_EXIT_CODES,
  habitantExitCondition,
} from "../src/habitant-exit.ts"
import { createYrdLogger, resolveYrdObservability } from "../src/observability.ts"
import {
  QUEUE_DRAIN_REASON_CODE,
  QUEUE_FATAL_EXIT,
  QUEUE_FATAL_REASON_CODE,
  drainedQueuePassExit,
  fatalQueueDrain,
  isQueuePassFatal,
  queueDrainReason,
  settleDrainedQueuePass,
  type QueuePassFatal,
} from "../src/queue-drain.ts"
import { followQueueRuns } from "../src/run.ts"
import { installDeclaredYrdEntry } from "./support/declared-yrd-entry.ts"
import { createHabitantHarness } from "./support/habitant-harness.ts"

const roots: string[] = []
const silentLog = createLogger("test", [{ level: "silent" }])

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const FATAL: QueuePassFatal = Object.freeze({
  kind: "fatal-error",
  namespace: "yrd:queue:compose",
  message: "queue could not journal PR7's required-check failure; the wedge oracle will under-count",
})

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

/** The same modelled journal `queue-drain.test.ts` drives: one run held by
 * this runner, one by a peer, verdict verbs that count their calls. */
function modelledQueue(runner: string) {
  const open = (id: string, held: string) => ({
    id,
    runner: held,
    status: "in_progress",
    reason: undefined as string | undefined,
  })
  const runs = [open("R7", runner), open("R8", "yrd-cli:other")]
  const verdictVerbs: string[] = []
  const queue = {
    recover: async (options: Readonly<{ recoveryTime: string; runner: string; reason: string }>) => {
      const settled = runs.filter((run) => run.runner === options.runner && run.status === "in_progress")
      for (const run of settled) {
        run.status = "completed"
        run.reason = options.reason
      }
      return settled.map((run) => ({ id: run.id }))
    },
    rejectChange: async () => void verdictVerbs.push("rejectChange"),
    cancelRun: async () => void verdictVerbs.push("cancelRun"),
  }
  return { queue, runs, verdictVerbs }
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
    raise: (event: "SIGINT" | "SIGTERM") => {
      for (const handler of [...(handlers.get(event) ?? [])]) handler()
    },
  }
}

describe("the exit code a pass leaves when its own ERROR row stopped it", () => {
  it("is a row in the taxonomy, distinct from 0, 1, 3, 16 and 124, dispositioned stand-down", () => {
    expect(QUEUE_FATAL_EXIT).toBe(HABITANT_EXIT["fatal-error"])
    for (const other of [0, 1, 2, 3, 124, HABITANT_EXIT.interrupted, HABITANT_EXIT.drained]) {
      expect(QUEUE_FATAL_EXIT).not.toBe(other)
    }
    expect(habitantExitCondition(QUEUE_FATAL_EXIT)).toBe("fatal-error")
    // ERROR is the abnormal-NOT-auto-fixable class: a restart is not the cure.
    expect(HABITANT_EXIT_DISPOSITION["fatal-error"]).toBe("stand-down")
    expect(HABITANT_STAND_DOWN_EXIT_CODES).toContain(QUEUE_FATAL_EXIT)
  })

  it("outranks the work's own result, a drain, and a hard signal", () => {
    expect(drainedQueuePassExit(0, { fatal: FATAL })).toBe(QUEUE_FATAL_EXIT)
    expect(drainedQueuePassExit(1, { fatal: FATAL })).toBe(QUEUE_FATAL_EXIT)
    // A signal that arrived while the pass was already draining for its ERROR
    // does not change what killed it.
    expect(drainedQueuePassExit(0, { drained: "SIGTERM", fatal: FATAL })).toBe(QUEUE_FATAL_EXIT)
    expect(drainedQueuePassExit(0, { hard: "SIGINT", fatal: FATAL })).toBe(QUEUE_FATAL_EXIT)
    // And the signal-only answers are untouched.
    expect(drainedQueuePassExit(0, { drained: "SIGTERM" })).toBe(HABITANT_EXIT.drained)
    expect(drainedQueuePassExit(0, { hard: "SIGINT" })).toBe(HABITANT_EXIT.interrupted)
  })
})

describe("an ERROR mid-pass settles the job in flight through the SAME drain a signal uses", () => {
  it("records the run terminal with a coded reason that names the row, leaving nothing in_progress", async () => {
    const model = modelledQueue("yrd-cli:9931")
    const { log, infos } = recordingLog()

    const settlement = await settleDrainedQueuePass(model.queue, "yrd-cli:9931", FATAL, log)

    const held = model.runs.find((run) => run.id === "R7")
    expect(held?.status).toBe("completed")
    expect(held?.status).not.toBe("in_progress")
    // A DIFFERENT code from a signal drain's — the reader who meets this run
    // later must be able to tell "a person stopped it" from "something is
    // wrong, and the row above says what".
    expect(held?.reason).toContain(QUEUE_FATAL_REASON_CODE)
    expect(held?.reason).not.toContain(QUEUE_DRAIN_REASON_CODE)
    expect(held?.reason).toContain("yrd:queue:compose")
    expect(held?.reason).toContain("wedge oracle will under-count")
    expect(held?.reason).toBe(queueDrainReason(FATAL))
    expect(settlement).toMatchObject({ runs: ["R7"], bounded: false, failed: false })
    // Runner-scoped, and no verdict verb: the pass never judged the content.
    expect(model.runs.find((run) => run.id === "R8")?.status).toBe("in_progress")
    expect(model.verdictVerbs).toEqual([])
    expect(infos.map((call) => call.props?.action)).toContain("queue-drain-settled")
    expect(infos[0]?.props).toMatchObject({ stop: "fatal-error", namespace: "yrd:queue:compose" })
  })

  it("keeps the signal path's own reason and props exactly as they were", async () => {
    const model = modelledQueue("yrd-cli:9931")
    const { log, infos } = recordingLog()
    await settleDrainedQueuePass(model.queue, "yrd-cli:9931", "SIGTERM", log)
    expect(model.runs.find((run) => run.id === "R7")?.reason).toBe(queueDrainReason("SIGTERM"))
    expect(infos[0]?.props).toMatchObject({ signal: "SIGTERM" })
  })
})

describe("the fatal stop enters the two-phase machine a signal enters", () => {
  it("asks first (drain, with the fatal cause), takes at the bound, and re-raises no signal", async () => {
    const runtime = fakeProcess()
    const drains: unknown[] = []
    const shutdowns: unknown[] = []
    const expired: unknown[] = []

    const binding = bindProcessShutdown<QueuePassFatal>(
      async (cause) => void shutdowns.push(cause),
      (cause) => void drains.push(cause),
      { ms: 1, onExpire: (cause) => void expired.push(cause) },
      runtime.runtime,
    )

    binding.stop(FATAL)
    // Phase one ASKS: the pass keeps running and stops on its own terms; the
    // abort reason it receives is the fatal cause, not a signal name.
    expect(drains).toEqual([FATAL])
    expect(shutdowns).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Phase two TAKES at the bound, exactly as an unanswered signal would.
    expect(expired).toEqual([FATAL])
    expect(shutdowns).toEqual([FATAL])
    // Nothing to re-raise: there is no signal, and the exit code is the
    // boundary's `fatal-error`, so `finish` must not kill the process.
    binding()
    expect(runtime.kills).toEqual([])
  })

  it("treats a signal after a fatal drain as the SECOND stop, not a fresh first one", async () => {
    const runtime = fakeProcess()
    const drains: unknown[] = []
    const shutdowns: unknown[] = []
    const binding = bindProcessShutdown<QueuePassFatal>(
      async (cause) => void shutdowns.push(cause),
      (cause) => void drains.push(cause),
      undefined,
      runtime.runtime,
    )
    binding.stop(FATAL)
    runtime.raise("SIGTERM")
    await Promise.resolve()
    expect(drains).toEqual([FATAL])
    expect(shutdowns).toEqual(["SIGTERM"])
    binding()
    // The hard stop WAS a signal this time, so its native status is restored.
    expect(runtime.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }])
  })

  it("carries the cause on the drain signal, where the resident loop reads it", () => {
    const drain = new AbortController()
    expect(fatalQueueDrain(drain.signal)).toBeUndefined()
    drain.abort(FATAL)
    expect(fatalQueueDrain(drain.signal)).toEqual(FATAL)
    // A signal drain aborts with the signal name and is NOT fatal.
    const signalled = new AbortController()
    signalled.abort("SIGTERM")
    expect(fatalQueueDrain(signalled.signal)).toBeUndefined()
    expect(isQueuePassFatal("SIGTERM")).toBe(false)
  })
})

describe("the logger latch that turns a row into a stop", () => {
  it("fires for the first ERROR row only, AFTER stderr has the row, and never for WARN", () => {
    const stderr: string[] = []
    const latched: Array<{ message: string; stderrLinesAtLatch: number }> = []
    const log = createYrdLogger(
      resolveYrdObservability({}, {}),
      (text) => void stderr.push(text),
      undefined,
      (event) => latched.push({ message: event.message, stderrLinesAtLatch: stderr.length }),
    )
    const queue = log.child("queue")
    queue.warn?.("a handled condition")
    expect(latched).toEqual([])
    queue.error?.("the row that kills the pass", { action: "admission-refusal-unrecorded" })
    queue.error?.("a later row")
    // Every ERROR reaches the listener (the host keeps only the first), and
    // the row was already flushed to stderr when the listener saw it.
    expect(latched.map((entry) => entry.message)).toEqual(["the row that kills the pass", "a later row"])
    expect(latched[0]?.stderrLinesAtLatch).toBe(2)
    expect(stderr[1]).toContain("the row that kills the pass")
    log.end()
  })
})

describe("the resident loop", () => {
  it("exits fatal-error, unclean, when its drain signal carries an ERROR cause", async () => {
    const harness = createHabitantHarness({
      run: async () => {
        // The host latched an ERROR row mid-run and asked the pass to stop.
        harness.stopForError(FATAL)
        return []
      },
    })
    await expect(followQueueRuns(harness.app, [], { interval: 1 }, harness.io, harness.gate)).resolves.toBe(
      HABITANT_EXIT["fatal-error"],
    )
    // One cycle: the run it was inside finished, then it left. It did not run
    // the queue again to "flush" the drain the way an operator's stop does.
    expect(harness.runCalls()).toBe(1)
  })

  it("still treats an operator's drain as the clean stop it is", async () => {
    const harness = createHabitantHarness({
      run: async () => {
        harness.drain()
        return []
      },
    })
    await expect(followQueueRuns(harness.app, [], { interval: 1 }, harness.io, harness.gate)).resolves.toBe(0)
  })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${String(exitCode)}: ${stderr}`)
  return stdout.trim()
}

/** `host.test.ts`'s repository fixture: one submittable branch on `main`. */
async function repository(): Promise<{ repo: string; featureSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-fatal-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), 'checks: [{check: {run: "true"}}]\n')
  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "switch", "-qc", "issue/feature")
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, "add", "feature.txt")
  await git(repo, "commit", "-qm", `feature\n\nChange-Id: I${"cafe".repeat(10)}`)
  const featureSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  return { repo, featureSha }
}

function createYrdHost(options: Parameters<typeof createYrdHostRaw>[0] = {}) {
  return createYrdHostRaw({ ...options, log: options.log ?? silentLog })
}

describe("a one-shot queue pass, end to end", () => {
  it("dies of its own ERROR row: exit 17, a terminal line naming the row, nothing left in_progress", async () => {
    const { repo, featureSha } = await repository()
    {
      await using submitter = await createYrdHost({ cwd: repo })
      await submitter.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      await submitter.close()
    }
    // The ERROR generator is the host being in trouble, not the change: the
    // Bay workspace root is unwritable, so provisioning the candidate's
    // workspace fails with an infrastructure failure the compose cannot absorb
    // — an ERROR row the pass would previously have died of with exit 3 and no
    // drain, or logged and carried past. A red check, by contrast, is a
    // verdict and settles at WARN.
    const bays = join(repo, ".bays")
    await mkdir(bays, { recursive: true })
    await chmod(bays, 0o000)

    let stderr = ""
    let exitCode: number
    try {
      exitCode = await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "queue", "run", "--json"], {
        cwd: repo,
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text
        },
      })
    } finally {
      await chmod(bays, 0o755)
    }

    // 1. The exit says what happened. Before this, the pass exited 1 (the run
    //    failed) — the same code a red check produces — with the ERROR row
    //    scrolled past and nothing stopped.
    expect(exitCode, stderr).toBe(HABITANT_EXIT["fatal-error"])
    for (const other of [0, 1, 3, 124]) expect(exitCode).not.toBe(other)

    // 2. The terminal line names what died and why: the namespace that emitted
    //    the row and the row's own message, after the row itself.
    const row = stderr.indexOf("ERROR yrd:")
    const terminal = stderr.indexOf("Queue pass stopped for an ERROR from yrd:")
    expect(row, stderr).toBeGreaterThanOrEqual(0)
    expect(terminal, stderr).toBeGreaterThan(row)
    expect(stderr.slice(terminal)).toContain("fatal-error")
    expect(stderr.slice(terminal)).toContain("exiting 17")

    // 3. Nothing is left in_progress for the next pass to find.
    await using inspector = await createYrdHost({ cwd: repo })
    const summary = inspector.app.queue.status("main")
    expect([...summary.running, ...summary.waiting].map((run) => run.id)).toEqual([])
    await inspector.close()
  }, 60_000)
})

// Keep the loggily Event type in play for the latch test's inference.
export type _FatalTestEvent = LogEvent
