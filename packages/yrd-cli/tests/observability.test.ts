/**
 * @failure Yrd logging controls leak into JSON stdout, fork severity policy, or invent identities outside delivery state.
 * @level l2
 * @consumer Yrd operators and observable CLI exemplars
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFailure } from "@yrd/core"
import { createLogger, type Event } from "loggily"
import { runObservableCli } from "../examples/observable-cli/index.ts"
import { runYrdProcess } from "../src/host.ts"
import {
  YRD_LIFECYCLE_LEVELS,
  createYrdLogger,
  observeYrdLifecycle,
  residentObservability,
  resolveYrdObservability,
} from "../src/observability.ts"

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
  await writeFile(join(repo, ".yrd.yml"), 'steps: [check]\ncheck: "true"\n')
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
    [{}, { DEBUG: "yrd:queue" }, { level: "warn", debug: "yrd:queue", spans: false, explicitLevel: false }],
    [{ verbose: 1 }, { LOG_LEVEL: "error" }, { level: "info", spans: false, explicitLevel: true }],
    [{ verbose: 2 }, { LOG_LEVEL: "error" }, { level: "debug", spans: true, explicitLevel: true }],
    [{ verbose: 3 }, { LOG_LEVEL: "error" }, { level: "trace", spans: true, explicitLevel: true }],
    [{ quiet: 1 }, { LOG_LEVEL: "trace" }, { level: "error", spans: false, explicitLevel: true }],
    [{ quiet: 2 }, { LOG_LEVEL: "trace" }, { level: "silent", spans: false, explicitLevel: true }],
    [{ logLevel: "debug" }, { LOG_LEVEL: "error" }, { level: "debug", spans: true, explicitLevel: true }],
  ] as const)("resolves CLI controls before LOG_LEVEL while DEBUG only filters namespaces", (flags, env, expected) => {
    expect(resolveYrdObservability(flags, env)).toEqual(expected)
  })

  it.each([
    [{ verbose: 3, quiet: 1 }, {}, "cannot combine --verbose and --quiet"],
    [{ verbose: 1, logLevel: "trace" }, {}, "cannot combine --log-level with --verbose or --quiet"],
    [{}, { LOG_LEVEL: "chatty" }, "LOG_LEVEL must be one of"],
  ] as const)("rejects contradictory or invalid controls", (flags, env, message) => {
    expect(() => resolveYrdObservability(flags, env)).toThrow(message)
  })
})

describe("resident runner observability", () => {
  it("raises the default warn to debug so lifecycle starts and completions print", () => {
    // The long-lived follow-runner's stderr IS a log stream; at the default
    // warn it never prints a run/step start or successful completion. Bump
    // warn → debug only when the operator has NOT chosen a level; the human
    // formatter keeps that richer event stream concise while JSONL stays full.
    const base = resolveYrdObservability({}, {})
    expect(base).toMatchObject({ level: "warn", explicitLevel: false })
    expect(residentObservability(base)).toMatchObject({ level: "debug", explicitLevel: false })
  })

  it("never overrides an explicit operator level (--log-level / LOG_LEVEL / -v / -q)", () => {
    // Each of these is an explicit choice; the resident honours it verbatim.
    for (const config of [
      resolveYrdObservability({}, { LOG_LEVEL: "warn" }), // explicit warn stays warn
      resolveYrdObservability({}, { LOG_LEVEL: "error" }),
      resolveYrdObservability({ quiet: 1 }, {}),
      resolveYrdObservability({ verbose: 2 }, {}),
      resolveYrdObservability({ logLevel: "debug" }, {}),
    ]) {
      expect(residentObservability(config)).toEqual(config)
    }
  })

  it("leaves a non-default resolved level untouched even without an explicit flag", () => {
    // Defensive: only the exact default (warn + not-explicit) is bumped.
    const trace = { level: "trace", spans: true, explicitLevel: false } as const
    expect(residentObservability(trace)).toEqual(trace)
  })

  it("admits only lifecycle-start DEBUG by default while keeping all warnings loud", () => {
    const human: string[] = []
    const config = residentObservability(resolveYrdObservability({}, {}))
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
    process.debug?.("process exited")
    process.warn?.("process drain warning")
    log.end()

    expect(human.join("")).toContain("check started")
    expect(human.join("")).toContain("process drain warning")
    expect(human.join("")).not.toContain("process exited")
  })

  it("preserves explicitly requested DEBUG on the human sink", () => {
    const human: string[] = []
    const config = residentObservability(resolveYrdObservability({ logLevel: "debug" }, {}))
    const log = createYrdLogger(
      config,
      (text) => human.push(text),
      (event) => (event.kind === "log" ? event.message : undefined),
    )
    log.child("process").debug?.("process exited")
    log.end()
    expect(human.join("")).toContain("process exited")
  })
})

describe("Yrd lifecycle records", () => {
  it("owns the only lifecycle-to-level authority table", () => {
    expect(YRD_LIFECYCLE_LEVELS).toEqual({
      started: "debug",
      progress: "trace",
      succeeded: "info",
      // An aggregate that completed carrying an already-reported failure: the
      // deepest failing job/step owns the single ERROR, so the enclosing
      // run/compose settle at INFO instead of re-raising the same failure.
      settled: "info",
      refused: "warn",
      recovered: "warn",
      failed: "error",
    })
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
    // The resident binds its identity ONCE at the logger scope (residentRunnerLog
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

  it("demotes routine lock and compose successes to DEBUG while keeping run success at INFO", async () => {
    const events: Event[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])

    await observeYrdLifecycle(log.child("journal"), { lifecycle: "lock" }, async () => undefined)
    await observeYrdLifecycle(log.child("queue"), { lifecycle: "compose" }, async () => [])
    await observeYrdLifecycle(log.child("queue"), { lifecycle: "run" }, async () => [])

    expect(
      events
        .filter((event): event is Extract<Event, { kind: "log" }> => event.kind === "log")
        .filter((event) => event.props?.outcome === "succeeded")
        .map((event) => [event.namespace, event.level]),
    ).toEqual([
      ["yrd:journal:lock", "debug"],
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
            correlation: { namespace: "review", id: "21125" },
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

    expect(events.find((event) => event.kind === "log" && event.message === "check started")).toMatchObject({
      kind: "log",
      namespace: "yrd:check",
      level: "debug",
      props: {
        lifecycle: "check",
        outcome: "started",
        correlation: { namespace: "review", id: "21125" },
        pr: "PR7",
        revision: 3,
        run: "R2",
        step: "check",
      },
    })
    expect(events.find((event) => event.kind === "log" && event.message === "check succeeded")).toMatchObject({
      kind: "log",
      namespace: "yrd:check",
      level: "info",
      message: "check succeeded",
      props: {
        lifecycle: "check",
        outcome: "succeeded",
        durationMs: 25,
        correlation: { namespace: "review", id: "21125" },
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
        correlation: { namespace: "review", id: "21125" },
        pr: "PR7",
        revision: 3,
        run: "R2",
        step: "check",
        outcome: "succeeded",
      },
    })
    log.end()
  })

  it("maps expected refusals to WARN and unexpected failures to ERROR", async () => {
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

    expect(
      events
        .filter((event): event is Extract<Event, { kind: "log" }> => event.kind === "log")
        .filter((event) => event.props?.outcome !== "started")
        .map((event) => [event.namespace, event.level, event.props?.outcome]),
    ).toEqual([
      ["yrd:admit", "warn", "refused"],
      ["yrd:remote", "error", "failed"],
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
        message: "check duration invalid",
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
      ["yrd:bay:submit", "yrd:journal:append", "yrd:journal:lock", "yrd:process:run"].includes(String(record.name)),
    )
    expect(evidence.find((record) => record.level === "info" && record.name === "yrd:bay:submit")).toEqual(
      expect.objectContaining({
        outcome: "succeeded",
        pr: "PR1",
        revision: 1,
        headSha,
        durationMs: expect.any(Number),
      }),
    )
    expect(
      evidence.find(
        (record) => record.level === "info" && record.name === "yrd:journal:append" && record.op === "bay.submit",
      ),
    ).toEqual(expect.objectContaining({ outcome: "succeeded", durationMs: expect.any(Number) }))
    expect(
      evidence.find(
        (record) => record.level === "debug" && record.name === "yrd:journal:lock" && record.outcome === "succeeded",
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
    const root = await mkdtemp(join(tmpdir(), "yrd-observable-cli-"))
    roots.push(root)
    const logFile = join(root, "yrd.jsonl")
    const stdout: string[] = []
    const stderr: string[] = []

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
