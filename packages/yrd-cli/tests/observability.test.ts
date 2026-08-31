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
    [{}, {}, { level: "warn", spans: false, explicitLevel: false }],
    [{}, { LOG_LEVEL: "info" }, { level: "info", spans: false, explicitLevel: true }],
    // DEBUG= implies debug severity when the operator chose no level. Setting a
    // namespace filter and getting silence is the trap this repo cares about:
    // the knob is documented, and used exactly as documented it emitted zero
    // bytes, which is why a multi-second stage stayed invisible for weeks.
    [{}, { DEBUG: "yrd:queue" }, { level: "debug", debug: "yrd:queue", spans: false, explicitLevel: false }],
    // The control that proves silence was never a namespace typo.
    [{}, { DEBUG: "*" }, { level: "debug", debug: "*", spans: false, explicitLevel: false }],
    // ...but an EXPLICIT level always wins over the implication, from any of the
    // three sources that count as an operator choice.
    [
      {},
      { DEBUG: "yrd:core", LOG_LEVEL: "warn" },
      { level: "warn", debug: "yrd:core", spans: false, explicitLevel: true },
    ],
    [{}, { LOG_LEVEL: "warn", TRACE: "yrd:*" }, { level: "warn", spans: true, explicitLevel: true }],
    [
      { logLevel: "error" },
      { DEBUG: "yrd:core" },
      { level: "error", debug: "yrd:core", spans: false, explicitLevel: true },
    ],
    [{ quiet: 1 }, { DEBUG: "yrd:core" }, { level: "error", debug: "yrd:core", spans: false, explicitLevel: true }],
    [{ verbose: 1 }, { DEBUG: "yrd:core" }, { level: "info", debug: "yrd:core", spans: false, explicitLevel: true }],
    [{ verbose: 1 }, { LOG_LEVEL: "error" }, { level: "info", spans: false, explicitLevel: true }],
    [{ verbose: 2 }, { LOG_LEVEL: "error" }, { level: "debug", spans: true, explicitLevel: true }],
    [{ verbose: 3 }, { LOG_LEVEL: "error" }, { level: "trace", spans: true, explicitLevel: true }],
    [{ quiet: 1 }, { LOG_LEVEL: "trace" }, { level: "error", spans: false, explicitLevel: true }],
    [{ quiet: 2 }, { LOG_LEVEL: "trace" }, { level: "silent", spans: false, explicitLevel: true }],
    [{ logLevel: "debug" }, { LOG_LEVEL: "error" }, { level: "debug", spans: true, explicitLevel: true }],
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
    const trace = { level: "trace", spans: true, explicitLevel: false } as const
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
      message: "compose settled: 1 failed, 1 passed",
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
    expect(settled).toMatchObject({ level: "info", message: "run settled" })
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

    expect(settledEvent("yrd:storage:append")?.message).toBe("append succeeded queue.advance")
    expect(settledEvent("yrd:storage:lock")?.message).toBe("lock succeeded checkpoint-save")
    // A journal frame's `command`/`cause` are UUIDs — they identify nothing a
    // reader can act on, so they are never the promoted subject.
    expect(settledEvent("yrd:storage:append")?.message).not.toContain("uuid")
    // Nothing scalar to name: a selectorless compose keeps the bare outcome
    // word rather than inventing a subject for it.
    expect(settledEvent("yrd:queue:compose")?.message).toBe("compose succeeded")

    expect(settledEvent("yrd:storage:append")?.props).toEqual(
      expect.objectContaining({ op: "queue.advance", command: "0f0f-frame-uuid", events: 0, cursor: 114_557 }),
    )
    log.end()
  })

  it("demotes routine lock and compose successes to DEBUG while keeping run success at INFO", async () => {
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])

    await observeYrdLifecycle(log.child("storage"), { lifecycle: "lock" }, async () => undefined)
    await observeYrdLifecycle(log.child("queue"), { lifecycle: "compose" }, async () => [])
    await observeYrdLifecycle(log.child("queue"), { lifecycle: "run" }, async () => [])

    expect(
      events
        .filter((event): event is Extract<Event, { kind: "log" }> => event.kind === "log")
        .filter((event) => event.props?.outcome === "succeeded")
        .map((event) => [event.namespace, event.level]),
    ).toEqual([
      ["yrd:storage:lock", "debug"],
      ["yrd:queue:compose", "debug"],
      ["yrd:queue:run", "info"],
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
    expect(events.find((event) => event.kind === "log" && event.message === "check started PR7")).toMatchObject({
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
    expect(events.find((event) => event.kind === "log" && event.message === "check succeeded PR7")).toMatchObject({
      kind: "log",
      namespace: "yrd:check",
      level: "info",
      message: "check succeeded PR7",
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
    expect(finished.map((event) => [event.namespace, event.level, event.props?.outcome])).toEqual([
      ["yrd:admit", "info", "failed"],
      ["yrd:remote", "info", "failed"],
    ])
    // The "refused" outcome retired: a typed domain refusal and an untyped
    // thrown error now share the one "failed" outcome, so the distinction
    // between them has to live somewhere else -- the attached failure
    // record's `kind` when there is one (a plain, non-YrdFailure Error, like
    // the "network down" throw above, carries none at all).
    expect(finished.map((event) => (event.props?.failure as { kind?: string } | undefined)?.kind)).toEqual([
      "refusal",
      undefined,
    ])
    log.end()
  })

  it("clamps a backwards clock and emits ERROR without failing successful work", async () => {
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])
    const ticks = [20, 10]

    await expect(
      observeYrdLifecycle(log, { lifecycle: "check", now: () => ticks.shift() ?? 10 }, async () => "passed"),
    ).resolves.toBe("passed")
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:check",
        level: "error",
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
    expect(
      evidence.find(
        (record) =>
          record.level === "info" && record.name === "yrd:storage:append" && record.op === "branch.recordSubmit",
      ),
    ).toEqual(expect.objectContaining({ outcome: "succeeded", durationMs: expect.any(Number) }))
    expect(
      evidence.find(
        (record) => record.level === "debug" && record.name === "yrd:storage:lock" && record.outcome === "succeeded",
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
    expect(stderr.join("")).toContain("resolve succeeded")
    const records = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          name: "yrd:resolve",
          msg: "resolve succeeded",
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
