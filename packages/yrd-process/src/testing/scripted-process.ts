/**
 * The typed owner double for the Process contract: a test scripts the output a child streams and the result it
 * settles with, and gets a Process back with no cast. `run` replays the script to the request's `onOutput` in order,
 * then resolves the scripted result; `close` and disposal settle at once because nothing was spawned.
 *
 * @fakes @yrd/process
 */
import type { Process, ProcessRequest, ProcessResult } from "../index.ts"

/** One streamed piece: a string is stdout text; otherwise the exact stream and bytes. */
export type ScriptedOutput = string | Readonly<{ stream: "stdout" | "stderr"; chunk: Uint8Array }>

type ExitedFields = Partial<
  Omit<ProcessResult, "timedOut" | "verdict" | "stalled" | "lastProgressAtMs" | "lastProgressBytes">
>

/** A child that exited on its own: exit code 0, no signal, empty output, unless `fields` says otherwise. */
export function exitedResult(fields: ExitedFields = {}): ProcessResult {
  return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 0, ...fields, timedOut: false }
}

/** A Process that streams `output` to each request and settles with `result` (default: {@link exitedResult}). */
export function createScriptedProcess(
  script: Readonly<{ output?: readonly ScriptedOutput[]; result?: ProcessResult }> = {},
): Process {
  const encoder = new TextEncoder()
  return {
    run: (request: ProcessRequest): Promise<ProcessResult> => {
      for (const output of script.output ?? []) {
        request.onOutput?.(typeof output === "string" ? { stream: "stdout", chunk: encoder.encode(output) } : output)
      }
      return Promise.resolve(script.result ?? exitedResult())
    },
    close: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  }
}
