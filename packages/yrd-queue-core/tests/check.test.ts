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
