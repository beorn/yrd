/**
 * @failure A supervised Git read is captured at 16 MiB while the local path streams, so the same call answers a
 *          complete list on one host and a hole on the other; or the stream adapter settles a killed, timed-out or
 *          failed run as a clean read.
 * @level l1
 * @consumer @yrd/process
 * @reach fs-walk <fixture-only: one temporary repository this test creates and reads>
 */
import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { assertStreamComplete, RETENTION_STREAM_QUEUE_LINES } from "git-super/process"
import { adaptProcessGit } from "../src/git-super.ts"
import { createProcess } from "../src/index.ts"

const MESSAGES = { timedOut: "timed out", capped: "capped", failed: "incomplete", warned: "warned" }
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "stream test",
  GIT_AUTHOR_EMAIL: "stream@example.test",
  GIT_COMMITTER_NAME: "stream test",
  GIT_COMMITTER_EMAIL: "stream@example.test",
  GIT_TERMINAL_PROMPT: "0",
}

function git(repo: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV, encoding: "utf8" }).trim()
}

/**
 * The Git port's `stream` is optional, while this suite exists to exercise exactly that method: a port without one
 * is a failure of what is being tested, not a reason to skip it.
 */
function streaming(adapted: ReturnType<typeof adaptProcessGit>): NonNullable<ReturnType<typeof adaptProcessGit>["stream"]> {
  const stream = adapted.stream
  if (stream === undefined) throw new Error("adaptProcessGit answered a Git port with no stream method")
  return stream
}

/** A repository whose one blob is 4096 one-byte-per-character lines: 20 MiB, past the 16 MiB capture limit. */
async function bigBlobRepo(): Promise<{ repo: string; sha: string; bytes: number }> {
  const repo = realpathSync(await mkdtemp(join(tmpdir(), "yrd-stream-")))
  git(repo, "init", "--quiet", "-b", "main")
  git(repo, "config", "user.name", "stream test")
  git(repo, "config", "user.email", "stream@example.test")
  const line = `${"a".repeat(4095)}\n`
  const content = line.repeat(5_120)
  await writeFile(join(repo, "big.txt"), content)
  git(repo, "add", "big.txt")
  git(repo, "commit", "--quiet", "-m", "big")
  return { repo, sha: git(repo, "rev-parse", "HEAD:big.txt"), bytes: Buffer.byteLength(content) }
}

describe("adaptProcessGit stream", () => {
  test("reads past the host's 16 MiB capture limit completely, where the buffered run truncates", async () => {
    const { repo, sha, bytes } = await bigBlobRepo()
    await using process = createProcess({ cwd: repo })
    const adapted = adaptProcessGit(process)
    try {
      const buffered = await adapted.run({ repo, args: ["cat-file", "blob", sha] })
      expect(buffered.failure).toContain("capture truncated")

      const stream = streaming(adapted)({ repo, args: ["cat-file", "blob", sha] })
      let lines = 0
      for await (const _line of stream.lines) lines += 1
      const outcome = await stream.outcome
      expect(outcome).toMatchObject({ code: 0, capped: false, timedOut: false, lines: 5_120 })
      expect(outcome.bytes).toBe(bytes)
      expect(() => assertStreamComplete(outcome, MESSAGES)).not.toThrow()
    } finally {
      safeRemoveSync(repo, { within: realpathSync(tmpdir()), allowMissing: true })
    }
  })

  test("a slow consumer keeps the queue at its bound instead of buffering the stream", async () => {
    const { repo, sha } = await bigBlobRepo()
    await using process = createProcess({ cwd: repo })
    const adapted = adaptProcessGit(process)
    try {
      const highs: number[] = []
      const stream = streaming(adapted)({
        repo,
        args: ["cat-file", "blob", sha],
        onQueueHighWater: (depth) => highs.push(depth),
      })
      let lines = 0
      for await (const _line of stream.lines) {
        lines += 1
        if (lines % 512 === 0) await new Promise((resolve) => setTimeout(resolve, 1))
      }
      expect(await stream.outcome).toMatchObject({ code: 0, lines: 5_120 })
      expect(Math.max(...highs)).toBeLessThanOrEqual(RETENTION_STREAM_QUEUE_LINES)
    } finally {
      safeRemoveSync(repo, { within: realpathSync(tmpdir()), allowMissing: true })
    }
  })

  test("a non-zero exit is an incomplete read, not an empty one", async () => {
    const repo = realpathSync(await mkdtemp(join(tmpdir(), "yrd-stream-")))
    git(repo, "init", "--quiet", "-b", "main")
    await using process = createProcess({ cwd: repo })
    try {
      const stream = streaming(adaptProcessGit(process))({ repo, args: ["rev-parse", "--verify", "refs/heads/nope"] })
      for await (const _line of stream.lines) {
        // nothing is expected; the outcome is the answer
      }
      const outcome = await stream.outcome
      expect(outcome.code).not.toBe(0)
      expect(() => assertStreamComplete(outcome, MESSAGES)).toThrow("incomplete")
    } finally {
      safeRemoveSync(repo, { within: realpathSync(tmpdir()), allowMissing: true })
    }
  })

  test("stdout capture truncation is not a stream failure; stderr truncation and an unproven verdict are", async () => {
    const stdoutTruncation = { stream: "stdout" as const, totalBytes: 900, keptBytes: 100, droppedBytes: 800, limitBytes: 100 }
    const stderrTruncation = { stream: "stderr" as const, totalBytes: 900, keptBytes: 100, droppedBytes: 800, limitBytes: 100 }
    const fake = (result: Record<string, unknown>) =>
      adaptProcessGit({
        async run(request) {
          request.onOutput?.({ stream: "stdout", chunk: new TextEncoder().encode("one\ntwo\n") })
          return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...result }
        },
      })

    const complete = streaming(fake({ outputTruncation: [stdoutTruncation] }))({ repo: "/repo", args: ["ls-tree", "-r"] })
    expect(await (async () => {
      const lines: string[] = []
      for await (const line of complete.lines) lines.push(line)
      return lines
    })()).toEqual(["one", "two"])
    expect(await complete.outcome).toMatchObject({ code: 0 })

    const stderrTruncated = streaming(fake({ outputTruncation: [stderrTruncation] }))({ repo: "/repo", args: ["ls-tree"] })
    for await (const _line of stderrTruncated.lines) {
      // drained for the outcome
    }
    expect(await stderrTruncated.outcome).toMatchObject({ code: 1 })

    const signaled = streaming(fake({ verdict: "SIGNALED" }))({ repo: "/repo", args: ["ls-tree"] })
    for await (const _line of signaled.lines) {
      // drained for the outcome
    }
    expect((await signaled.outcome).stderr).toContain("process verdict SIGNALED")
  })

  test("a timeout and an abort both settle the framing as incomplete", async () => {
    const timedOut = streaming(adaptProcessGit({
      async run() {
        return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: true }
      },
    }))({ repo: "/repo", args: ["ls-tree"] })
    for await (const _line of timedOut.lines) {
      // drained for the outcome
    }
    const timedOutOutcome = await timedOut.outcome
    expect(timedOutOutcome).toMatchObject({ code: 1, timedOut: true })
    expect(() => assertStreamComplete(timedOutOutcome, MESSAGES)).toThrow("timed out")

    const controller = new AbortController()
    const aborted = streaming(adaptProcessGit({
      async run(request) {
        request.onOutput?.({ stream: "stdout", chunk: new TextEncoder().encode("kept\n") })
        await new Promise((resolve) => setTimeout(resolve, 5))
        controller.abort()
        return { exitCode: 143, signal: "SIGKILL", stdout: "", stderr: "", durationMs: 5, timedOut: false }
      },
    }))({ repo: "/repo", args: ["ls-tree"], signal: controller.signal })
    const lines: string[] = []
    for await (const line of aborted.lines) lines.push(line)
    const abortedOutcome = await aborted.outcome
    expect(lines).toEqual(["kept"])
    expect(abortedOutcome.code).not.toBe(0)
    expect(() => assertStreamComplete(abortedOutcome, MESSAGES)).toThrow("incomplete")
  })
})
