import { createGitLineStream } from "git-super/process"
import type { GitProcess, GitProcessResult } from "git-super/process"
import type { OutputTruncation, Process } from "./index.ts"

export type GitProcessDefaults = Readonly<{
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}>

/** Remove caller-owned Git routing variables before selecting a repository.
 * Git honors these variables ahead of `-C`, so every CLI Git boundary shares
 * this scrubber rather than allowing ambient hook state to change authority. */
export function cleanGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  )
}

function gitEnvironment(source: NodeJS.ProcessEnv, overlay: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    ...cleanGitEnvironment(source),
    ...overlay,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    TZ: "UTC",
  }
}

/** Yrd's only adapter from its supervised process port to git-super's Git port. */
export function adaptProcessGit(process: Pick<Process, "run">, defaults: GitProcessDefaults = {}): GitProcess {
  return {
    async run(request) {
      const argv = ["git", "-C", request.repo, ...request.args]
      const env = gitEnvironment(defaults.env ?? globalThis.process.env, request.env)
      const result = await process.run({
        argv,
        cwd: request.repo,
        env,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...((request.signal ?? defaults.signal) === undefined ? {} : { signal: request.signal ?? defaults.signal }),
        ...((request.timeoutMs ?? defaults.timeoutMs) === undefined
          ? {}
          : { timeoutMs: request.timeoutMs ?? defaults.timeoutMs }),
      })
      const truncation = truncationFailure(argv, result.outputTruncation ?? [])
      const settlement =
        (result.verdict !== undefined && result.verdict !== "EXITED") || result.sweepFailure !== undefined
          ? (result.sweepFailure ?? `process verdict ${result.verdict}`)
          : undefined
      const failure = [truncation, settlement].filter((entry): entry is string => entry !== undefined).join("; ")
      return {
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        signal: result.signal,
        timedOut: result.timedOut,
        ...(result.stalled === undefined ? {} : { stalled: result.stalled }),
        ...(failure === "" ? {} : { failure }),
      }
    },
    /**
     * The same Git call, streamed instead of captured: every stdout byte reaches one {@link createGitLineStream}
     * framer, so a read past the host's 16 MiB capture limit stays complete rather than arriving as a head and a
     * tail with a hole between them. The run result settles the framing, and only failures that make the bytes
     * themselves incomplete count: stdout capture truncation does not (the framer already saw those bytes), while
     * stderr truncation still does, because a warning Git wrote there is evidence the read is short.
     */
    stream(request) {
      const argv = ["git", "-C", request.repo, ...request.args]
      const env = gitEnvironment(defaults.env ?? globalThis.process.env, request.env)
      // One signal stops the child for both causes: the caller cancelling, and a framing bound being crossed.
      const stop = new AbortController()
      const outer = request.signal ?? defaults.signal
      if (outer !== undefined) {
        if (outer.aborted) stop.abort()
        else outer.addEventListener("abort", () => stop.abort(), { once: true })
      }
      const framer = createGitLineStream({
        ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
        ...(request.maxLines === undefined ? {} : { maxLines: request.maxLines }),
        ...(request.framing === undefined ? {} : { framing: request.framing }),
        ...(request.onQueueHighWater === undefined ? {} : { onQueueHighWater: request.onQueueHighWater }),
        onCap: () => stop.abort(),
      })
      const timeoutMs = request.timeoutMs ?? defaults.timeoutMs
      void process
        .run({
          argv,
          cwd: request.repo,
          env,
          signal: stop.signal,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          onOutput: (output) => (output.stream === "stdout" ? framer.write(output.chunk) : undefined),
        })
        .then(
          async (result) => {
            await framer.end()
            const failure = streamSettlementFailure(argv, result)
            framer.settle({
              code: result.exitCode,
              stderr: result.stderr,
              ...(result.timedOut ? { timedOut: true } : {}),
              ...(failure === undefined ? {} : { failure }),
            })
          },
          (error: unknown) => {
            framer.fail(error)
          },
        )
      return framer
    },
  }
}

/**
 * The settlement failures that make a STREAMED read incomplete, as opposed to a captured one.
 *
 * A capture that ran past its limit drops the middle of the text, so `truncationFailure` names both streams there.
 * In stream mode the observer already received every stdout byte, so a stdout truncation says nothing about the
 * stream - counting it would turn a complete read into a false refusal. Stderr is different: it is still captured
 * text, and Git writes an unusable alternate or a broken ref there without a non-zero exit.
 */
function streamSettlementFailure(
  argv: readonly string[],
  result: Readonly<{
    verdict?: string
    sweepFailure?: string
    stalled?: boolean
    escapedDescendant?: boolean
    outputTruncation?: readonly OutputTruncation[]
  }>,
): string | undefined {
  const parts: string[] = []
  if (result.verdict !== undefined && result.verdict !== "EXITED") parts.push(`process verdict ${result.verdict}`)
  if (result.sweepFailure !== undefined) parts.push(result.sweepFailure)
  if (result.stalled === true) parts.push("the process stalled and was stopped")
  if (result.escapedDescendant === true)
    parts.push("a descendant held stdout open past the child's exit, so the drain was abandoned")
  const stderrTruncation = truncationFailure(
    argv,
    (result.outputTruncation ?? []).filter((entry) => entry.stream === "stderr"),
  )
  if (stderrTruncation !== undefined) parts.push(stderrTruncation)
  return parts.length === 0 ? undefined : parts.join("; ")
}

/**
 * Past `maxOutputBytes` the capture keeps a head and a tail, drops the middle, lets the child exit 0, and
 * names the loss only in this field and a WARN line — so a consumer that parses stdout reads a hole as a
 * complete answer (the one oversized file that bounces the queue, 24650/24669). Reported as `failure`,
 * the field every consumer already refuses, and named with the command and the exact limit it ran past.
 */
function truncationFailure(argv: readonly string[], truncations: readonly OutputTruncation[]): string | undefined {
  if (truncations.length === 0) return undefined
  const losses = truncations
    .map(
      ({ stream, droppedBytes, totalBytes, limitBytes }) =>
        `${stream}: ${String(droppedBytes)} of ${String(totalBytes)} bytes dropped past the ${String(limitBytes)}-byte capture limit`,
    )
    .join("; ")
  return `${argv.join(" ")}: capture truncated (${losses}), so the middle of the output is gone and this read is not complete`
}

/** One human-readable line for a failed `adaptProcessGit` call: the process-level
 * failure if there is one (a crash, a signal, a sweep that could not certify
 * teardown), else the timeout, else Git's own stderr/stdout, else the bare exit
 * code. `timeoutMs` only labels a timeout that already happened — it does not
 * configure one. */
export function gitFailure(result: GitProcessResult, timeoutMs: number): string {
  if (result.timedOut === true) return `timed out after ${String(timeoutMs)}ms`
  return result.failure ?? (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`)
}
