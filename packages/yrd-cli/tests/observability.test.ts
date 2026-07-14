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
    [{}, {}, { level: "warn", spans: false }],
    [{}, { LOG_LEVEL: "info" }, { level: "info", spans: false }],
    [{}, { DEBUG: "yrd:queue" }, { level: "warn", debug: "yrd:queue", spans: false }],
    [{ verbose: 1 }, { LOG_LEVEL: "error" }, { level: "info", spans: false }],
    [{ verbose: 2 }, { LOG_LEVEL: "error" }, { level: "debug", spans: true }],
    [{ verbose: 3 }, { LOG_LEVEL: "error" }, { level: "trace", spans: true }],
    [{ quiet: 1 }, { LOG_LEVEL: "trace" }, { level: "error", spans: false }],
    [{ quiet: 2 }, { LOG_LEVEL: "trace" }, { level: "silent", spans: false }],
    [{ logLevel: "debug" }, { LOG_LEVEL: "error" }, { level: "debug", spans: true }],
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

describe("Yrd lifecycle records", () => {
  it("owns the only lifecycle-to-level authority table", () => {
    expect(YRD_LIFECYCLE_LEVELS).toEqual({
      started: "debug",
      progress: "trace",
      succeeded: "info",
      refused: "warn",
      recovered: "warn",
      failed: "error",
    })
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
      .map((line) => JSON.parse(line) as Record<string, unknown>)
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
    expect(evidence.find((record) => record.level === "info" && record.name === "yrd:journal:lock")).toEqual(
      expect.objectContaining({ outcome: "succeeded", durationMs: expect.any(Number) }),
    )
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
      .map((line) => JSON.parse(line) as Record<string, unknown>)
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
      .map((line) => JSON.parse(line) as Record<string, unknown>)
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
      .map((line) => JSON.parse(line) as Record<string, unknown>)
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
      .map((line) => JSON.parse(line) as Record<string, unknown>)
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
