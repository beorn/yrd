/**
 * One check's log, as the person watching the queue reads it.
 *
 * The measured defect these cases stand against (live merge queue, 2026-09-09):
 * a check's log did not exist until the check exited, so `yrd queue show` said
 * "running; nothing written yet" for the whole fourteen minutes of an affected-
 * tests run and nobody could tell a slow check from a wedged one. Every case
 * here asserts on the FILE — what is in it, and when — because the file is the
 * instrument, and an assertion on the returned result would pass just as
 * happily against the defect.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Process, ProcessRequest, ProcessResult } from "@yrd/process"
import { checkLogPath, runCheck } from "../src/index.ts"
import type { CheckedTree } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const TREE: CheckedTree = { base: "0".repeat(40), candidate: "1".repeat(40) }

/** A scratch worktree, log directory and temp root for one check. */
function place(name: string): Readonly<{ cwd: string; logDir: string; tmpdir: string; tree: CheckedTree }> {
  const root = mkdtempSync(join(tmpdir(), `yrd-check-${name}-`))
  roots.push(root)
  return { cwd: root, logDir: join(root, "checks"), tmpdir: join(root, "tmp"), tree: TREE }
}

/** Poll a condition to a bound; returns whether it ever held. */
async function until(held: () => boolean, boundMs: number): Promise<boolean> {
  const deadline = Date.now() + boundMs
  while (Date.now() < deadline) {
    if (held()) return true
    await new Promise((wake) => setTimeout(wake, 10))
  }
  return held()
}

describe("a check's log while the check runs", () => {
  it("holds the check's first line before the check has finished, and both lines when it has", async () => {
    const where = place("streams")
    const path = checkLogPath(where.logDir, "watch")
    let settled = false

    // One second between the two lines: long enough that reading the first one
    // off disk cannot be an artifact of the check already being over.
    const running = runCheck({
      ...where,
      spec: { name: "watch", run: "echo first-marker; sleep 1; echo second-marker" },
    }).then((result) => {
      settled = true
      return result
    })

    // Nothing has been awaited yet, so this is the state at spawn time: the log
    // is created before the child, not after it exits.
    expect(existsSync(path), `${path} must exist as soon as the check is started`).toBe(true)

    const streamed = await until(() => readFileSync(path, "utf8").includes("first-marker"), 5000)
    expect(streamed, `first-marker never reached ${path} while the check was running`).toBe(true)
    // The whole point. If the check had already finished, reading its first line
    // off disk would prove nothing at all.
    expect(settled, "the check finished before its first line was read, so this proves nothing").toBe(false)
    expect(readFileSync(path, "utf8")).not.toContain("second-marker")

    const result = await running
    expect(result.result).toBe("pass")
    expect(result.log).toBe(path)
    // Exactly the bytes the check wrote: no header, no preamble, nothing yrd
    // added to a log that had nothing to report.
    expect(readFileSync(path, "utf8")).toBe("first-marker\nsecond-marker\n")
  })

  it("interleaves stdout and stderr in arrival order, with no rule drawn between them", async () => {
    const where = place("interleave")
    const path = checkLogPath(where.logDir, "both")

    // The writes are spaced so the order on disk is the order they happened,
    // not a race between two readers of two pipes.
    const result = await runCheck({
      ...where,
      spec: { name: "both", run: "echo one; sleep 0.2; echo two >&2; sleep 0.2; echo three" },
    })

    expect(result.result).toBe("pass")
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\nthree\n")
    // A log written as it arrives cannot sort one stream after the other: it
    // would have to hold every byte back until both streams were complete,
    // which is the defect. The old separator is gone with that wait.
    expect(readFileSync(path, "utf8")).not.toContain("--- stderr ---")
  })

  it("gives a check that says nothing an empty log rather than no log", async () => {
    const where = place("quiet")
    const path = checkLogPath(where.logDir, "quiet")

    const result = await runCheck({ ...where, spec: { name: "quiet", run: "exit 0" } })

    expect(result.result).toBe("pass")
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf8")).toBe("")
  })
})

describe("a check log is written once", () => {
  it("refuses a path that already exists, keeps the first program's bytes, and never starts the check", async () => {
    const where = place("taken")
    mkdirSync(where.logDir, { recursive: true })
    const path = checkLogPath(where.logDir, "taken")
    writeFileSync(path, "the first program's bytes\n")
    const sentinel = join(where.cwd, "the-check-ran.txt")

    await expect(runCheck({ ...where, spec: { name: "taken", run: `touch ${sentinel}` } })).rejects.toThrow(
      `a check log already exists at ${path}`,
    )

    expect(readFileSync(path, "utf8")).toBe("the first program's bytes\n")
    // Create-only is now decided before the child is spawned, so the loser of a
    // collision does not spend its whole bound running a check whose evidence it
    // could never publish.
    expect(existsSync(sentinel), "the check ran even though its log path was taken").toBe(false)
  })
})

/**
 * A driver that streams what it is told to and returns whatever result the case
 * needs, so the two things the file cannot show on its own — a capture budget
 * overrun, and where the log's bytes came from — can be asserted exactly.
 */
function stubDriver(streamed: readonly string[], dropped?: ProcessResult["outputTruncation"]): Process {
  const encoder = new TextEncoder()
  return {
    run: (request: ProcessRequest): Promise<ProcessResult> => {
      for (const text of streamed) request.onOutput?.({ stream: "stdout", chunk: encoder.encode(text) })
      return Promise.resolve({
        exitCode: 0,
        signal: null,
        // Deliberately NOT what was streamed: a log built from this text instead
        // of from the stream is the whole-file write this change removed.
        stdout: "the captured text, which the log must not be written from",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        ...(dropped === undefined ? {} : { outputTruncation: dropped }),
      })
    },
    close: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  }
}

/**
 * @failure A caller can smuggle its own program root into a check, making the
 *          check read candidate-owned code after the queue selected a root.
 * @level l1 (an injected Process boundary and temporary filesystem inspect the runner request before a child can run).
 * @consumer Queue checks that opt into the immutable program-root capability.
 */
describe("a queue-owned program root", () => {
  it("overwrites passed-through and check-requested program roots only for an explicit opt-in", async () => {
    const where = place("program-root")
    const programRoot = join(where.cwd, "target-program")
    let request: ProcessRequest | undefined
    const process: Process = {
      run: (received) => {
        request = received
        return Promise.resolve({ durationMs: 1, exitCode: 0, signal: null, stderr: "", stdout: "", timedOut: false })
      },
      close: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    }

    await expect(
      runCheck({
        ...where,
        env: { PATH: "/test/path", YRD_PROGRAM_ROOT: "/inherited-program" },
        extraEnv: { YRD_PROGRAM_ROOT: "/check-requested-program" },
        process,
        programRoot,
        spec: { environmentPassthrough: ["YRD_PROGRAM_ROOT"], name: "program", programRoot: true, run: "unused" },
      }),
    ).resolves.toMatchObject({ result: "pass" })

    expect(request?.cwd).toBe(where.cwd)
    expect(request?.env?.YRD_PROGRAM_ROOT).toBe(programRoot)
    expect(request?.env?.YRD_REPO).toBe(where.cwd)
    expect(request?.env?.YRD_CANDIDATE_SHA).toBe(TREE.candidate)
    expect(request?.env?.YRD_BASE_SHA).toBe(TREE.base)
  })

  it("refuses missing or relative opt-ins and program roots supplied to legacy checks", async () => {
    const absolute = join(place("absolute-program-root").cwd, "program")

    await expect(
      runCheck({ ...place("missing-program-root"), spec: { name: "missing", programRoot: true, run: "exit 0" } }),
    ).rejects.toThrow(/programRoot: true requires an absolute programRoot/u)
    await expect(
      runCheck({
        ...place("relative-program-root"),
        programRoot: "relative-program",
        spec: { name: "relative", programRoot: true, run: "exit 0" },
      }),
    ).rejects.toThrow(/programRoot must be an absolute path/u)
    await expect(
      runCheck({ ...place("legacy-program-root"), programRoot: absolute, spec: { name: "legacy", run: "exit 0" } }),
    ).rejects.toThrow(/does not declare programRoot: true/u)
  })

  it("removes both passed-through and check-requested roots from legacy checks", async () => {
    const where = place("legacy-program-root-spoof")
    let request: ProcessRequest | undefined
    const process: Process = {
      run: (received) => {
        request = received
        return Promise.resolve({ durationMs: 1, exitCode: 0, signal: null, stderr: "", stdout: "", timedOut: false })
      },
      close: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    }

    await expect(
      runCheck({
        ...where,
        env: { PATH: "/test/path", YRD_PROGRAM_ROOT: "/inherited-program" },
        extraEnv: { YRD_PROGRAM_ROOT: "/check-requested-program" },
        process,
        spec: { environmentPassthrough: ["YRD_PROGRAM_ROOT"], name: "legacy", run: "unused" },
      }),
    ).resolves.toMatchObject({ result: "pass" })

    expect(request?.env?.YRD_PROGRAM_ROOT).toBeUndefined()
  })
})

describe("a check log and the text the queue read", () => {
  it("holds the streamed bytes only, never a second copy written at the end", async () => {
    const where = place("streamed-only")
    const path = checkLogPath(where.logDir, "streamed")

    const result = await runCheck({
      ...where,
      spec: { name: "streamed", run: "unused" },
      process: stubDriver(["what the check actually wrote\n"]),
    })

    expect(result.result).toBe("pass")
    expect(readFileSync(path, "utf8")).toBe("what the check actually wrote\n")
  })

  it("says in one line that the queue's captured text is short, rather than letting the two look alike", async () => {
    const where = place("truncated")
    const path = checkLogPath(where.logDir, "loud")

    const result = await runCheck({
      ...where,
      spec: { name: "loud", run: "unused" },
      process: stubDriver(
        ["every byte of it\n"],
        [{ stream: "stdout", totalBytes: 4096, keptBytes: 1024, droppedBytes: 3072, limitBytes: 1024 }],
      ),
    })

    // Dropped capture is already the queue's own ground for "not measured".
    expect(result.result).toBe("stuck")
    expect(result.exit).toBe("unsettled")
    const written = readFileSync(path, "utf8")
    expect(written).toContain("every byte of it\n")
    // The numbers, so a reader can tell which of the two is short and by how
    // much, instead of comparing a full file against a truncated verdict text
    // and concluding the file lost something.
    expect(written).toContain("[yrd: stdout ran past the 1024-byte capture budget: 3072 of 4096 bytes are missing")
    expect(written).toContain("every byte its capture observed was streamed to this file]")
  })
})

describe("check exit codes", () => {
  it("treats 0 as pass and 1 as fail", async () => {
    const pass = await runCheck({ ...place("exit-0"), spec: { name: "ok", run: "exit 0" } })
    expect(pass).toMatchObject({ exit: 0, result: "pass" })
    const fail = await runCheck({ ...place("exit-1"), spec: { name: "red", run: "exit 1" } })
    expect(fail).toMatchObject({ exit: 1, result: "fail" })
  })

  it("treats 2 as stuck — the check said the queue could not judge", async () => {
    const result = await runCheck({ ...place("exit-2"), spec: { name: "env", run: "exit 2" } })
    expect(result).toMatchObject({
      exit: 2,
      result: "stuck",
      why: "the check said it could not judge",
    })
  })

  it("bounces exit 3 cannot-judge to the submitter as fail, not stuck", async () => {
    const result = await runCheck({ ...place("exit-3"), spec: { name: "affected-tests", run: "exit 3" } })
    expect(result).toMatchObject({
      exit: 3,
      result: "fail",
      why: "cannot-judge: bounced to the submitter",
    })
  })

  it("treats any other code as stuck — not a verdict", async () => {
    const result = await runCheck({ ...place("exit-99"), spec: { name: "weird", run: "exit 99" } })
    expect(result).toMatchObject({
      exit: 99,
      result: "stuck",
      why: "exit 99 is not a verdict",
    })
  })
})
