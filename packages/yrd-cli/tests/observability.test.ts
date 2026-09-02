/**
 * @failure Yrd logging controls leak into JSON stdout, fork severity policy, or invent identities outside delivery state.
 * @level l2
 * @consumer Yrd operators and observable CLI exemplars
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFailure } from "@yrd/core"
import { createLogger, type Event } from "loggily"
import { runObservableCli } from "../examples/observable-cli/index.ts"
import { runYrdProcess } from "../src/host.ts"
import {
  HABITANT_LIFECYCLE_NAMESPACES,
  YRD_LIFECYCLE_LEVELS,
  createYrdLogger,
  observeYrdLifecycle,
  habitantObservability,
  resolveYrdObservability,
} from "../src/observability.ts"
import { installDeclaredYrdEntry } from "./support/declared-yrd-entry.ts"

const roots: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function repository(root: string): Promise<string> {
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), 'checks:\n  - {check: {run: "true"}}\n')
  await installDeclaredYrdEntry(repo)
  await git(repo, "add", "README.md", ".yrd.yml")
  await git(repo, "commit", "-qm", "main")
  return repo
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Yrd observability controls", () => {
  it.each([
    [{}, {}, { level: "warn", spans: false, spanRows: false, explicitLevel: false }],
    [{}, { LOG_LEVEL: "info" }, { level: "info", spans: false, spanRows: false, explicitLevel: true }],
    // DEBUG= implies debug severity when the operator chose no level. Setting a
    // namespace filter and getting silence is the trap this repo cares about:
    // the knob is documented, and used exactly as documented it emitted zero
    // bytes, which is why a multi-second stage stayed invisible for weeks.
    [
      {},
      { DEBUG: "yrd:queue" },
      { level: "debug", debug: "yrd:queue", spans: true, spanRows: false, explicitLevel: false },
    ],
    // The control that proves silence was never a namespace typo.
    // DEBUG= reaches debug, so spans are CONSTRUCTED — the stage breakdown is
    // derived from construction and `DEBUG=yrd:perf` is how it is read. It just
    // prints none of them.
    [{}, { DEBUG: "*" }, { level: "debug", debug: "*", spans: true, spanRows: false, explicitLevel: false }],
    // ...but an EXPLICIT level always wins over the implication, from any of the
    // three sources that count as an operator choice.
    [
      {},
      { DEBUG: "yrd:core", LOG_LEVEL: "warn" },
      { level: "warn", debug: "yrd:core", spans: false, spanRows: false, explicitLevel: true },
    ],
    [{}, { LOG_LEVEL: "warn", TRACE: "yrd:*" }, { level: "warn", spans: true, spanRows: true, explicitLevel: true }],
    [
      { logLevel: "error" },
      { DEBUG: "yrd:core" },
      { level: "error", debug: "yrd:core", spans: false, spanRows: false, explicitLevel: true },
    ],
    [
      { quiet: 1 },
      { DEBUG: "yrd:core" },
      { level: "error", debug: "yrd:core", spans: false, spanRows: false, explicitLevel: true },
    ],
    [
      { verbose: 1 },
      { DEBUG: "yrd:core" },
      { level: "info", debug: "yrd:core", spans: false, spanRows: false, explicitLevel: true },
    ],
    [{ verbose: 1 }, { LOG_LEVEL: "error" }, { level: "info", spans: false, spanRows: false, explicitLevel: true }],
    [{ verbose: 2 }, { LOG_LEVEL: "error" }, { level: "debug", spans: true, spanRows: true, explicitLevel: true }],
    [{ verbose: 3 }, { LOG_LEVEL: "error" }, { level: "trace", spans: true, spanRows: true, explicitLevel: true }],
    [{ quiet: 1 }, { LOG_LEVEL: "trace" }, { level: "error", spans: false, spanRows: false, explicitLevel: true }],
    [{ quiet: 2 }, { LOG_LEVEL: "trace" }, { level: "silent", spans: false, spanRows: false, explicitLevel: true }],
    [
      { logLevel: "debug" },
      { LOG_LEVEL: "error" },
      { level: "debug", spans: true, spanRows: true, explicitLevel: true },
    ],
  ] as const)(
    "resolves CLI controls before LOG_LEVEL, and DEBUG implies debug unless a level was chosen",
    (flags, env, expected) => {
      expect(resolveYrdObservability(flags, env)).toEqual(expected)
    },
  )

  it.each([
    [{ verbose: 3, quiet: 1 }, {}, "cannot combine --verbose and --quiet"],
    [{ verbose: 1, logLevel: "trace" }, {}, "cannot combine --log-level with --verbose or --quiet"],
    [{}, { LOG_LEVEL: "chatty" }, "LOG_LEVEL must be one of"],
  ] as const)("rejects contradictory or invalid controls", (flags, env, message) => {
    expect(() => resolveYrdObservability(flags, env)).toThrow(message)
  })
})

describe("habitant runner observability", () => {
  it("raises the default warn to debug so lifecycle starts and completions print", () => {
    // The long-lived follow-runner's stderr IS a log stream; at the default
    // warn it never prints a run/step start or successful completion. Bump
    // warn → debug only when the operator has NOT chosen a level; the human
    // formatter keeps that richer event stream concise while JSONL stays full.
    const base = resolveYrdObservability({}, {})
    expect(base).toMatchObject({ level: "warn", explicitLevel: false })
    expect(habitantObservability(base)).toMatchObject({ level: "debug", explicitLevel: false })
  })

  it("never overrides an explicit operator level (--log-level / LOG_LEVEL / -v / -q)", () => {
    // Each of these is an explicit choice; the habitant honours it verbatim.
    for (const config of [
      resolveYrdObservability({}, { LOG_LEVEL: "warn" }), // explicit warn stays warn
      resolveYrdObservability({}, { LOG_LEVEL: "error" }),
      resolveYrdObservability({ quiet: 1 }, {}),
      resolveYrdObservability({ verbose: 2 }, {}),
      resolveYrdObservability({ logLevel: "debug" }, {}),
    ]) {
      expect(habitantObservability(config)).toEqual(config)
    }
  })

  it("leaves a non-default resolved level untouched even without an explicit flag", () => {
    // Defensive: only the exact default (warn + not-explicit) is bumped.
    const trace = { level: "trace", spans: true, spanRows: true, explicitLevel: false } as const
    expect(habitantObservability(trace)).toEqual(trace)
  })

  it("admits only lifecycle-start DEBUG by default while keeping all warnings loud", () => {
    const human: string[] = []
    const config = habitantObservability(resolveYrdObservability({}, {}))
    const log = createYrdLogger(
      config,
      (text) => human.push(text),
      (event) => (event.kind === "log" ? event.message : undefined),
    )
    const lifecycle = log.child("jobs").child("check")
    const process = log.child("process")

    expect(lifecycle.debug).toBeTypeOf("function")
    expect(process.debug).toBeUndefined()
    lifecycle.debug?.("check started")
    process.debug?.("Command finished.")
    process.warn?.("process drain warning")
    log.end()

    expect(human.join("")).toContain("check started")
    expect(human.join("")).toContain("process drain warning")
    expect(human.join("")).not.toContain("Command finished.")
  })

  it("preserves explicitly requested DEBUG on the human sink", () => {
    const human: string[] = []
    const config = habitantObservability(resolveYrdObservability({ logLevel: "debug" }, {}))
    const log = createYrdLogger(
      config,
      (text) => human.push(text),
      (event) => (event.kind === "log" ? event.message : undefined),
    )
    log.child("process").debug?.("Command finished.")
    log.end()
    expect(human.join("")).toContain("Command finished.")
  })

  // 2026-08-28: the queue's explanation of an empty run never reached anyone.
  // The narration allowlist held `yrd:queue:run`; the queue plugin logs on
  // `yrd.log.child("queue")`, and nothing in src has ever created a `run` child.
  // A namespace that matches nothing gates its own diagnostics away, and the
  // gate deletes the METHOD, so `log.info?.(…)` became a no-op with no error
  // and no stream. Measured on the live runner: 427 WARN and 0 INFO on
  // `yrd:queue`.
  it("shows the queue's own explanation of an empty run, on the namespace the queue actually has", () => {
    const human: string[] = []
    const config = habitantObservability(resolveYrdObservability({}, {}))
    const log = createYrdLogger(
      config,
      (text) => human.push(text),
      (event) => (event.kind === "log" ? event.message : undefined),
    )
    const queue = log.child("queue")

    expect(queue.info, "the queue plugin's own logger must be able to speak").toBeTypeOf("function")
    queue.info?.("queue run emitted zero events because nothing is submitted")
    log.end()

    expect(human.join("")).toContain("nothing is submitted")
  })

  it("never deletes `info` from a logger — only the `debug`/`trace` payloads the gate was written for", () => {
    const human: string[] = []
    const config = habitantObservability(resolveYrdObservability({}, {}))
    const log = createYrdLogger(
      config,
      (text) => human.push(text),
      (event) => (event.kind === "log" ? event.message : undefined),
    )
    const process = log.child("process")

    // Yrd spends INFO on the lines that separate an honest zero from a surface
    // that never looked. Deleting one is indistinguishable from never reaching
    // the code, so the source-side gate may not touch that level.
    expect(process.info, "`info` is a diagnostic level and is never gated away").toBeTypeOf("function")
    // The optimisation itself stays: heavy payloads are still never built.
    expect(process.debug, "`debug` off the narration path is still free").toBeUndefined()
    expect(process.trace).toBeUndefined()
  })

  it("names only namespaces that some logger in src actually creates", async () => {
    // The bug above was not a wrong policy, it was a dead string. Nothing
    // connected the allowlist to the loggers it claims to admit, so an entry
    // could name a namespace that had never existed and read as deliberate.
    //
    // Comments are stripped first, and that is not incidental: the first
    // version of this check passed against the very bug it was written to
    // catch, because the comment explaining the dead `child("run")` contained
    // the string it searched for. Stripping can only over-remove, which fails
    // loud, so the error direction is the safe one.
    const root = new URL("../../..", import.meta.url).pathname
    const sources = new Bun.Glob("packages/*/src/**/*.ts").scan({ cwd: root })
    let src = ""
    for await (const file of sources) src += await Bun.file(`${root}/${file}`).text()
    const code = src.replaceAll(/\/\*[\s\S]*?\*\//g, " ").replaceAll(/\/\/[^\n]*/g, " ")

    expect(code.length, "positive control: the scan read yrd's sources, and stripping left them").toBeGreaterThan(
      1_000_000,
    )
    expect(code, "positive control: a namespace that IS created survives stripping").toContain('child("queue")')

    const unreachable = HABITANT_LIFECYCLE_NAMESPACES.filter((namespace) =>
      namespace
        .split(":")
        .slice(1)
        .some((segment) => !code.includes(`child("${segment}")`) && !code.includes(`createLogger("yrd:${segment}")`)),
    )
    expect(unreachable, "every narration namespace must be one a logger in src can have").toEqual([])
  })
})

describe("Yrd lifecycle records", () => {
  it("defines default lifecycle levels before the delivery-step start promotion", () => {
    expect(YRD_LIFECYCLE_LEVELS).toEqual({
      started: "debug",
      progress: "trace",
      succeeded: "info",
      // An aggregate that completed carrying an already-reported failure: the
      // deepest failing job/step owns the single ERROR, so the enclosing
      // run/compose settle at INFO instead of re-raising the same failure.
      settled: "info",
      recovered: "warn",
      failed: "info",
    })
  })

  it("promotes delivery-step starts to INFO while other lifecycle starts stay DEBUG", async () => {
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])

    await observeYrdLifecycle(
      log,
      { lifecycle: "check", identity: { run: "R1", step: "check" }, now: () => 1 },
      async () => "ok",
    )
    await observeYrdLifecycle(log, { lifecycle: "run", identity: { run: "R1" }, now: () => 1 }, async () => "ok")

    const starts = events.filter(
      (event): event is Extract<Event, { kind: "log" }> => event.kind === "log" && event.props?.outcome === "started",
    )
    expect(starts.map(({ namespace, level }) => ({ namespace, level }))).toEqual([
      { namespace: "yrd:check", level: "info" },
      { namespace: "yrd:run", level: "debug" },
    ])
    log.end()
  })

  it("classifies an aggregate settlement as INFO and applies a mixed-outcome label to the message", async () => {
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])

    await expect(
      observeYrdLifecycle(
        log,
        {
          lifecycle: "compose",
          outcome: () => "settled",
          label: () => "settled: 1 failed, 1 passed",
          now: () => 10,
        },
        async () => "done",
      ),
    ).resolves.toBe("done")

    const settled = events.find(
      (event): event is Extract<Event, { kind: "log" }> => event.kind === "log" && event.props?.outcome === "settled",
    )
    // Message carries the mixed label (not the flat outcome word), at INFO so it
    // never re-reports the failure the deepest job already raised at ERROR.
    expect(settled).toMatchObject({
      namespace: "yrd:compose",
      level: "info",
      message: "settled: 1 failed, 1 passed",
      props: expect.objectContaining({ outcome: "settled", summary: "settled: 1 failed, 1 passed" }),
    })
    log.end()
  })

  it("inherits scope-bound runner/host/pane without re-declaring them per event", async () => {
    // The habitant binds its identity ONCE at the logger scope (habitantRunnerLog
    // = log.child({ runner, host, pane })). A lifecycle observed under that scope
    // must inherit those fields WITHOUT the observe options re-passing them, so
    // per-event payloads carry only event-specific fields.
    const events: Event[] = []
    const root = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])
    const scoped = root.child({ runner: "yrd-cli:42", host: "unimac", pane: "wC:p7" }).child("queue")

    // Note: the observe options declare NO runner/host/pane — only the run id.
    await observeYrdLifecycle(scoped, { lifecycle: "compose", identity: { run: "R7" }, now: () => 1 }, async () => "ok")

    const done = events.find(
      (event): event is Extract<Event, { kind: "log" }> => event.kind === "log" && event.props?.outcome === "succeeded",
    )
    expect(done).toMatchObject({
      namespace: "yrd:queue:compose",
      props: expect.objectContaining({ runner: "yrd-cli:42", host: "unimac", pane: "wC:p7", run: "R7" }),
    })
    root.end()
  })

  it("keeps the flat outcome word when no label is supplied", async () => {
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])
    await observeYrdLifecycle(log, { lifecycle: "run", outcome: () => "settled", now: () => 5 }, async () => 0)
    const settled = events.find(
      (event): event is Extract<Event, { kind: "log" }> => event.kind === "log" && event.props?.outcome === "settled",
    )
    expect(settled).toMatchObject({ level: "info", message: "settled" })
    expect(settled?.props).not.toHaveProperty("summary")
    log.end()
  })

  it("names the subject in the lifecycle message while leaving every field in the payload", async () => {
    // Negative control: this rendered exactly `${lifecycle} ${descriptor}`, so
    // every journal append was the identical string "append succeeded" and a
    // reader had to parse the payload to learn WHICH op the row was about. The
    // message assertions below fail against that rendering; the payload
    // assertion holds under both, because promoting a field into the headline
    // must never move it out of `props`.
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])

    await observeYrdLifecycle(
      log.child("storage"),
      {
        lifecycle: "append",
        identity: { command: "0f0f-frame-uuid", cause: "beef-frame-uuid", op: "queue.advance" },
        attributes: { expectedCursor: 114_556, events: 0 },
        resultAttributes: (result: { cursor: number }) => result,
        now: () => 0,
      },
      async () => ({ cursor: 114_557 }),
    )
    await observeYrdLifecycle(
      log.child("storage"),
      { lifecycle: "lock", attributes: { holder: "checkpoint-save", path: "/x/writer.lock" }, now: () => 0 },
      async () => undefined,
    )
    await observeYrdLifecycle(log.child("queue"), { lifecycle: "compose", now: () => 0 }, async () => [])

    const settledEvent = (namespace: string) =>
      events.find(
        (event): event is Extract<Event, { kind: "log" }> =>
          event.kind === "log" && event.namespace === namespace && event.props?.outcome === "succeeded",
      )

    // `subject verb object`, with the lifecycle word dropped because the
    // namespace already carries it — `yrd:storage:lock lock succeeded` said
    // `lock` twice and named neither the holder nor the file.
    expect(settledEvent("yrd:storage:append")?.message).toBe("appended queue.advance")
    expect(settledEvent("yrd:storage:lock")?.message).toBe("checkpoint-save locked /x/writer.lock")
    // A journal frame's `command`/`cause` are UUIDs — they identify nothing a
    // reader can act on, so they are never the promoted subject.
    expect(settledEvent("yrd:storage:append")?.message).not.toContain("uuid")
    // Nothing scalar to name: a selectorless compose keeps the bare outcome
    // word rather than inventing a subject for it.
    expect(settledEvent("yrd:queue:compose")?.message).toBe("succeeded")

    expect(settledEvent("yrd:storage:append")?.props).toEqual(
      expect.objectContaining({ op: "queue.advance", command: "0f0f-frame-uuid", events: 0, cursor: 114_557 }),
    )
    log.end()
  })

  it("names the change, the verdict and the elapsed time when a job lifecycle fails", async () => {
    // Negative control: this row read `affected-tests failed` on namespace
    // `yrd:jobs:affected-tests` — the message repeated the namespace verbatim
    // and then added the weakest available verb, so a reader watching eight
    // runs could not tell which change it was about without opening the JSON.
    // `toBe` below fails against that rendering.
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])
    const clock = [0, 339_032]

    await observeYrdLifecycle(
      log.child("jobs"),
      {
        lifecycle: "affected-tests",
        identity: { step: "affected-tests", attempt: 1 },
        attributes: {
          prs: [{ pr: "PR2831", revision: 1, headSha: "907d422c", branch: "task/embed-location-km-pin" }],
        },
        outcome: () => "failed",
        resultAttributes: (result: { status: string; conclusion: string }) => result,
        now: () => clock.shift() ?? 339_032,
      },
      // `resultAttributes` is only consulted for a non-undefined result, which
      // is how the real job path reports its verdict.
      async () => ({ status: "completed", conclusion: "timed_out" }),
    )

    const failed = events.find(
      (event): event is Extract<Event, { kind: "log" }> => event.kind === "log" && event.props?.outcome === "failed",
    )
    // `step` is the lifecycle here, so the namespace already says
    // "affected-tests" and the message spends its width on the change, the
    // verdict and how long it burned. 339032ms reads 5m39s, which is what says
    // this died nowhere near a two-hour ceiling.
    expect(failed?.namespace).toBe("yrd:jobs:affected-tests")
    expect(failed?.message).toBe("failed PR2831 [timed_out] 5m39s")
    // Every promoted value is still in the payload, and so is everything that
    // was never promoted.
    expect(failed?.props).toEqual(
      expect.objectContaining({
        step: "affected-tests",
        attempt: 1,
        status: "completed",
        conclusion: "timed_out",
        durationMs: 339_032,
        prs: [{ pr: "PR2831", revision: 1, headSha: "907d422c", branch: "task/embed-location-km-pin" }],
      }),
    )
    log.end()
  })

  /**
   * Three tiers, and each one is a decision.
   *
   * Storage bookkeeping — the writer lock and the journal append — reads at
   * TRACE. It is the journal talking to itself: one queue run takes the lock
   * and appends a frame for every fact it writes, and at debug that transcript
   * buried the queue's own decisions (565 rows for one empty-lane queue run,
   * 308 of them lock and append, measured 2026-09-02 on pin 0749260a). Same
   * class as the git chatter moved to trace in 8975957f, moved the same way.
   *
   * Composition reads at DEBUG: routine per-cycle plumbing, useful when an
   * operator asks for it. A queue run reads at INFO because it is a delivery
   * milestone.
   */
  it("puts storage bookkeeping at TRACE, compose at DEBUG and a queue run at INFO", async () => {
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])

    await observeYrdLifecycle(log.child("storage"), { lifecycle: "lock" }, async () => undefined)
    await observeYrdLifecycle(log.child("storage"), { lifecycle: "append" }, async () => undefined)
    await observeYrdLifecycle(log.child("queue"), { lifecycle: "compose" }, async () => [])
    await observeYrdLifecycle(log.child("queue"), { lifecycle: "run" }, async () => [])

    expect(
      events
        .filter((event): event is Extract<Event, { kind: "log" }> => event.kind === "log")
        .filter((event) => event.props?.outcome === "succeeded")
        .map((event) => [event.namespace, event.level]),
    ).toEqual([
      ["yrd:storage:lock", "trace"],
      ["yrd:storage:append", "trace"],
      ["yrd:queue:compose", "debug"],
      ["yrd:queue:run", "info"],
    ])
    log.end()
  })

  /**
   * Bookkeeping goes quiet when it goes right, and stays exactly as loud when
   * it does not. A lock that could not be taken is a fault, and demoting the
   * whole lifecycle would have taken the fault down with the chatter.
   */
  it("keeps a failed lock and a failed append loud", async () => {
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])

    for (const lifecycle of ["lock", "append"]) {
      await expect(
        observeYrdLifecycle(log.child("storage"), { lifecycle }, async () => {
          throw new Error("the writer lock is held")
        }),
      ).rejects.toThrow("the writer lock is held")
    }

    expect(
      events
        .filter((event): event is Extract<Event, { kind: "log" }> => event.kind === "log")
        .filter((event) => event.props?.outcome === "failed")
        .map((event) => [event.namespace, event.level]),
    ).toEqual([
      ["yrd:storage:lock", "error"],
      ["yrd:storage:append", "error"],
    ])
    log.end()
  })

  it("reuses delivery identities and records duration without journal facts", async () => {
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])
    const ticks = [100, 125]

    await expect(
      observeYrdLifecycle(
        log,
        {
          lifecycle: "check",
          identity: {
            props: { review: "21125" },
            pr: "PR7",
            revision: 3,
            run: "R2",
            step: "check",
          },
          now: () => ticks.shift() ?? 125,
        },
        async () => "passed",
      ),
    ).resolves.toBe("passed")

    // `PR7` is the promoted subject: the most specific identity this
    // lifecycle carries. It is a headline for the payload below, never a
    // replacement for it.
    expect(events.find((event) => event.kind === "log" && event.message === "started PR7")).toMatchObject({
      kind: "log",
      namespace: "yrd:check",
      level: "info",
      props: {
        lifecycle: "check",
        outcome: "started",
        props: { review: "21125" },
        pr: "PR7",
        revision: 3,
        run: "R2",
        step: "check",
      },
    })
    expect(events.find((event) => event.kind === "log" && event.message === "succeeded PR7")).toMatchObject({
      kind: "log",
      namespace: "yrd:check",
      level: "info",
      message: "succeeded PR7",
      props: {
        lifecycle: "check",
        outcome: "succeeded",
        durationMs: 25,
        props: { review: "21125" },
        pr: "PR7",
        revision: 3,
        run: "R2",
        step: "check",
      },
    })
    expect(events.find((event) => event.kind === "span")).toMatchObject({
      kind: "span",
      namespace: "yrd:check",
      props: {
        props: { review: "21125" },
        pr: "PR7",
        revision: 3,
        run: "R2",
        step: "check",
        outcome: "succeeded",
      },
    })
    log.end()
  })

  it("leaves command failures to the CLI while habitants retain their lifecycle records", async () => {
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])

    await expect(
      observeYrdLifecycle(log, { lifecycle: "admit", now: () => 10 }, async () => {
        throw createFailure({ kind: "refusal", code: "not-ready", message: "PR is not ready" })
      }),
    ).rejects.toThrow("PR is not ready")
    await expect(
      observeYrdLifecycle(log, { lifecycle: "remote", now: () => 20 }, async () => {
        throw new Error("network down")
      }),
    ).rejects.toThrow("network down")

    const finished = events
      .filter((event): event is Extract<Event, { kind: "log" }> => event.kind === "log")
      .filter((event) => event.props?.outcome !== "started")
    // The "refused" outcome retired: a typed domain refusal and an untyped
    // thrown error now share the one "failed" outcome, so the distinction
    // between them lives in the attached failure record's `kind` -- AND, since
    // the three-way failure model (normal/recoverable/not-auto-fixable), in the
    // level itself: a known, caller-attributable refusal settles at the
    // abnormal-recoverable WARN, while a thrown error this module cannot
    // classify at all (not a YrdFailure -- "network down" carries no `kind`) is
    // presumptively the worse class and stays loud at ERROR.
    expect(finished.map((event) => [event.namespace, event.level, event.props?.outcome])).toEqual([
      ["yrd:admit", "warn", "failed"],
      ["yrd:remote", "error", "failed"],
    ])
    expect(finished.map((event) => (event.props?.failure as { kind?: string } | undefined)?.kind)).toEqual([
      "refusal",
      undefined,
    ])
    log.end()
  })

  it("settles usage/configuration failures at WARN like refusal, but keeps infrastructure loud at ERROR", async () => {
    // The doc'd three-way split for a THROWN failure: refusal/usage/configuration
    // are known, caller-attributable rejections (WARN, abnormal-recoverable --
    // the operation's own caller already has what it needs to act), while
    // infrastructure is the abnormal-not-auto-fixable class that stays loud.
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])

    await expect(
      observeYrdLifecycle(log, { lifecycle: "usage", now: () => 10 }, async () => {
        throw createFailure({ kind: "usage", code: "bad-flag", message: "unknown flag --nope" })
      }),
    ).rejects.toThrow("unknown flag --nope")
    await expect(
      observeYrdLifecycle(log, { lifecycle: "config", now: () => 15 }, async () => {
        throw createFailure({ kind: "configuration", code: "bad-yaml", message: ".yrd.yml is malformed" })
      }),
    ).rejects.toThrow(".yrd.yml is malformed")
    await expect(
      observeYrdLifecycle(log, { lifecycle: "infra", now: () => 20 }, async () => {
        throw createFailure({ kind: "infrastructure", code: "disk-full", message: "no space left on device" })
      }),
    ).rejects.toThrow("no space left on device")

    const finished = events
      .filter((event): event is Extract<Event, { kind: "log" }> => event.kind === "log")
      .filter((event) => event.props?.outcome !== "started")
    expect(finished.map((event) => [event.namespace, event.level])).toEqual([
      ["yrd:usage", "warn"],
      ["yrd:config", "warn"],
      ["yrd:infra", "error"],
    ])
    log.end()
  })

  it("keeps a thrown failure at the quiet default when reportedAtBoundary says someone else already reports it", async () => {
    // A one-shot command's own top-level lifecycle (e.g. yrd-bay's intake/submit)
    // is already reported by the CLI boundary, which always prints a final
    // structured error regardless of level. Promoting the SAME thrown failure to
    // WARN/ERROR here would print a second line onto the same default stderr
    // stream -- for `--json`, one that breaks single-blob JSON parsing (measured:
    // `yrd pr create --json` against an unfetchable origin, 2026-08-31). This is
    // the thrown-branch counterpart of why `settled` stays quiet when a deeper
    // step already owns the one loud report.
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])

    await expect(
      observeYrdLifecycle(log, { lifecycle: "submit", reportedAtBoundary: true, now: () => 10 }, async () => {
        throw createFailure({ kind: "configuration", code: "submit-branch-refresh-failed", message: "no origin" })
      }),
    ).rejects.toThrow("no origin")
    await expect(
      observeYrdLifecycle(log, { lifecycle: "infra", reportedAtBoundary: true, now: () => 15 }, async () => {
        throw createFailure({ kind: "infrastructure", code: "disk-full", message: "no space left on device" })
      }),
    ).rejects.toThrow("no space left on device")

    const finished = events
      .filter((event): event is Extract<Event, { kind: "log" }> => event.kind === "log")
      .filter((event) => event.props?.outcome !== "started")
    expect(finished.map((event) => [event.namespace, event.level, event.props?.outcome])).toEqual([
      ["yrd:submit", "info", "failed"],
      ["yrd:infra", "info", "failed"],
    ])
    log.end()
  })

  it("clamps a backwards clock and emits WARN without failing successful work", async () => {
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])
    const ticks = [20, 10]

    await expect(
      observeYrdLifecycle(log, { lifecycle: "check", now: () => ticks.shift() ?? 10 }, async () => "passed"),
    ).resolves.toBe("passed")
    // WARN, not ERROR: the measurement is abnormal (a backwards clock) but the
    // work itself is unaffected and nothing needs a human to intervene.
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:check",
        level: "warn",
        props: expect.objectContaining({
          lifecycle: "check",
          outcome: "succeeded",
          diagnostic: "invalid-duration",
          startedAt: 20,
          finishedAt: 10,
          durationMs: 0,
        }),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:check",
        level: "info",
        props: expect.objectContaining({ outcome: "succeeded", durationMs: 0 }),
      }),
    )
    log.end()
  })
})

describe("observable CLI exemplar", () => {
  it("emits correlated submit, journal, lock, and remote lifecycle evidence from the shipping CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-observable-submit-"))
    roots.push(root)
    const repo = await repository(root)
    await git(repo, "switch", "-qc", "issue/observable")
    await writeFile(join(repo, "README.md"), "observable\n")
    await git(repo, "add", "README.md")
    await git(repo, "commit", "-qm", "observable")
    const headSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "switch", "-q", "main")
    const logFile = join(root, "yrd.jsonl")
    const stdout: string[] = []
    const stderr: string[] = []
    const previous = { LOGGILY_FILE: process.env.LOGGILY_FILE, NO_COLOR: process.env.NO_COLOR }
    process.env.LOGGILY_FILE = logFile
    process.env.NO_COLOR = "1"
    try {
      expect(
        await runYrdProcess(
          ["yrd", "-vvv", "--repo", repo, "pr", "submit", "issue/observable", "--base", "main", "--json"],
          {
            cwd: root,
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text),
            color: false,
          },
        ),
        stderr.join(""),
      ).toBe(0)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    expect(() => JSON.parse(stdout.join(""))).not.toThrow()
    const records = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    const evidence = records.filter((record) =>
      ["yrd:bay", "yrd:bay:submit", "yrd:storage:append", "yrd:storage:lock", "yrd:process:run"].includes(
        String(record.name),
      ),
    )
    // A recordless direct branch routes to the derived lane: the submit
    // lifecycle succeeds on the branch identity (no pr/revision — no record
    // mints), and the routing record carries the exact head the fact recorded.
    const submitted = evidence.find((record) => record.level === "info" && record.name === "yrd:bay:submit")
    expect(submitted).toEqual(
      expect.objectContaining({
        outcome: "succeeded",
        branch: "issue/observable",
        durationMs: expect.any(Number),
      }),
    )
    const routed = evidence.find((record) => record.name === "yrd:bay" && record.action === "submit-derived-routed")
    expect(routed).toEqual(expect.objectContaining({ branch: "issue/observable", sha: headSha, base: "main" }))
    expect(routed?.trace_id, "derived routing must correlate with the submit lifecycle").toBe(submitted?.trace_id)
    // Storage bookkeeping reads at TRACE, which `-vvv` is: the rows moved down
    // a level rather than away, and this is where that is proved end to end
    // through the shipping CLI rather than through the wrapper alone.
    // `outcome` is named rather than inferred from the level: the started and
    // finished rows share one level now, so the level no longer tells them
    // apart and a predicate that leaned on it would find the wrong row.
    expect(
      evidence.find(
        (record) =>
          record.level === "trace" &&
          record.name === "yrd:storage:append" &&
          record.op === "branch.recordSubmit" &&
          record.outcome === "succeeded",
      ),
    ).toEqual(expect.objectContaining({ outcome: "succeeded", durationMs: expect.any(Number) }))
    expect(
      evidence.find(
        (record) => record.level === "trace" && record.name === "yrd:storage:lock" && record.outcome === "succeeded",
      ),
    ).toEqual(expect.objectContaining({ durationMs: expect.any(Number) }))
    expect(
      evidence.find(
        (record) => record.level === "span" && record.name === "yrd:process:run" && record.outcome === "succeeded",
      ),
    ).toEqual(expect.objectContaining({ durationMs: expect.any(Number) }))
  })

  it("keeps the installed -vvv --json command machine-pure while one logger owns diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-observable-command-"))
    roots.push(root)
    const repo = await repository(root)
    const logFile = join(root, "yrd.jsonl")
    const stdout: string[] = []
    const stderr: string[] = []
    const previous = {
      DEBUG: process.env.DEBUG,
      LOGGILY_FILE: process.env.LOGGILY_FILE,
      LOG_LEVEL: process.env.LOG_LEVEL,
      NO_COLOR: process.env.NO_COLOR,
    }
    delete process.env.DEBUG
    process.env.LOGGILY_FILE = logFile
    process.env.LOG_LEVEL = "error"
    process.env.NO_COLOR = "1"
    try {
      expect(
        await runYrdProcess(["yrd", "-vvv", "--repo", repo, "queue", "--json"], {
          cwd: root,
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
          color: false,
        }),
        stderr.join(""),
      ).toBe(0)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    expect(() => JSON.parse(stdout.join(""))).not.toThrow()
    expect(stderr.join("")).toContain("SPAN yrd:")
    const records = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    expect(records.some((record) => record.level === "span" && String(record.name).startsWith("yrd:"))).toBe(true)
  })

  it("keeps JSON stdout pure while -vvv diagnostics reach stderr and LOGGILY_FILE", async () => {
    // Keep the random basename below the approved token-shape redaction length;
    // this test asserts path fidelity, not the redaction matcher covered upstream.
    const root = await mkdtemp(join(tmpdir(), "yrd-oc-"))
    roots.push(root)
    const logFile = join(root, "yrd.jsonl")
    const stdout: string[] = []
    const stderr: string[] = []
    await mkdir(join(root, "caller"))
    await mkdir(join(root, "selected"))

    const exitCode = await runObservableCli({
      globals: { repo: "../selected", verbose: 3 },
      env: { YRD_REPO: "../ignored", LOGGILY_FILE: logFile },
      ambientCwd: join(root, "caller"),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.join(""))).toEqual({ repo: join(root, "selected") })
    expect(stderr.join("")).toContain("yrd:resolve succeeded")
    const records = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          name: "yrd:resolve",
          msg: "succeeded",
          repo: join(root, "selected"),
        }),
      ]),
    )
  })

  it("uses one host logger for stderr and lossless JSONL file output", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-logger-"))
    roots.push(root)
    const logFile = join(root, "yrd.jsonl")
    const stderr: string[] = []
    const config = resolveYrdObservability({ verbose: 3 }, { DEBUG: "yrd:queue", LOGGILY_FILE: logFile })
    const log = createYrdLogger(config, (text) => stderr.push(text))

    log.child("queue").info?.("queue admitted", { pr: "PR1", revision: 2 })
    log.child("core").error?.("must be namespace-filtered")
    log.end()

    expect(stderr.join("")).toContain("queue admitted")
    expect(stderr.join("")).not.toContain("must be namespace-filtered")
    const records = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    expect(records).toEqual([
      expect.objectContaining({ level: "info", name: "yrd:queue", msg: "queue admitted", pr: "PR1", revision: 2 }),
    ])
  })

  it("parents nested remote spans to the existing delivery trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-trace-context-"))
    roots.push(root)
    const logFile = join(root, "yrd.jsonl")
    const log = createYrdLogger(resolveYrdObservability({ verbose: 3 }, { LOGGILY_FILE: logFile }), () => {})
    const delivery = log.child("jobs").span?.("check", { pr: "PR1", revision: 2, run: "R3", step: "check" })
    const remote = log.child("process").span?.("run", { argv: ["git", "fetch", "origin"] })
    remote?.end()
    delivery?.end()
    log.end()

    const records = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    const check = records.find((record) => record.name === "yrd:jobs:check")
    const process = records.find((record) => record.name === "yrd:process:run")
    expect(check).toEqual(expect.objectContaining({ trace_id: expect.any(String), span_id: expect.any(String) }))
    expect(process).toEqual(
      expect.objectContaining({
        trace_id: check?.trace_id,
        parent_id: check?.span_id,
        argv: ["git", "fetch", "origin"],
      }),
    )
  })
})
