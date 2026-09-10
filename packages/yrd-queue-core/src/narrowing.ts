/**
 * What a check says its BASE comparison needs, and the queue's one reading of
 * it.
 *
 * A candidate that fails a check is not yet attributed: the same check runs
 * once more on the settled base — the target with this candidate's raises and
 * none of its authored content — and a base that fails too makes the raise the
 * fault rather than the submitter (run.ts `attributedFailure`). That second run
 * exists to answer ONE question — does the settled base fail the same things?
 * — and re-running the whole check to answer it is what costs the queue a
 * second full check on every failure. Measured on hh-dev 2026-09-10, run
 * q-20260910T063044822Z-41b0c4ff: the merge phase's check took 5.3 min and
 * named one candidate-attributable test id; the base phase then re-ran the
 * identical plan for 4.7 min to say that id was green there.
 *
 * A check knows what its base run must measure, and nothing else does. So the
 * check says it, on its own log, on one line:
 *
 *     YRD-BASE-NARROWING {"env":{"AFFECTED_TESTS_ONLY":"tools/pool.test.ts"}}
 *
 * The queue reads the LAST such line off the log of the check that failed and
 * puts those names in the environment of that same check's base run. Nothing
 * here knows what the names mean: the check that wrote them is the check that
 * reads them back, and a queue that understood them would be a queue that has
 * to be changed whenever a check is.
 *
 * Absent is ordinary — a check that offers no narrowing gets the full base run
 * it has always had. Present and unusable is NOT ordinary and is never quietly
 * treated as absent: it comes back as a refusal with its own sentence, the base
 * run is the full one, and the journal row says which of the two ran.
 */

import { open } from "node:fs/promises"

/** The line a check writes to offer its base run a narrower scope. */
export const BASE_NARROWING_MARKER = "YRD-BASE-NARROWING"

/** How much of a check's log is read looking for that line: it is written last. */
export const BASE_NARROWING_TAIL_BYTES = 1024 * 1024

/** The queue's own statements about the tree, which a check may not overwrite. */
const RESERVED = new Set(["TMPDIR", "PATH", "HOME", "SHELL", "LANG", "USER", "LOGNAME"])

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/u
const MAX_NAMES = 8
const MAX_VALUE_BYTES = 4096
const MAX_PAYLOAD_BYTES = 64 * 1024

/**
 * What a check's log offered its base run.
 *
 * `none` is the ordinary reading and the ordinary outcome: the base run is the
 * whole check. `refused` is a marker line that could not be honoured, with the
 * sentence saying why — the base run is the whole check there too, and the
 * difference between the two is exactly what a reader loses when a defect is
 * folded into an absence.
 */
export type BaseNarrowing =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "narrowed"; env: Readonly<Record<string, string>> }>
  | Readonly<{ kind: "refused"; why: string }>

/**
 * The last narrowing a check's log offers, read out of the text of that log.
 *
 * The LAST one: a check that re-runs a leg may say this more than once, and the
 * one that describes the run just judged is the one it wrote last. Earlier
 * lines are superseded, never merged — merging two offers would produce a scope
 * neither of them named.
 */
export function readNarrowing(text: string): BaseNarrowing {
  const marked = text.split("\n").filter((line) => line.startsWith(`${BASE_NARROWING_MARKER} `))
  const line = marked.at(-1)
  if (line === undefined) return { kind: "none" }
  const payload = line.slice(BASE_NARROWING_MARKER.length + 1).trim()
  const refuse = (why: string): BaseNarrowing => ({ kind: "refused", why: `${BASE_NARROWING_MARKER}: ${why}` })
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
    return refuse(
      `its payload is ${String(Buffer.byteLength(payload))} bytes, past the ${String(MAX_PAYLOAD_BYTES)}-byte bound`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    return refuse(`its payload is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("its payload is not an object")
  }
  const offered = (parsed as { env?: unknown }).env
  if (typeof offered !== "object" || offered === null || Array.isArray(offered)) {
    return refuse("its `env` is not an object of names to values")
  }
  const entries = Object.entries(offered as Record<string, unknown>)
  if (entries.length === 0) return refuse("its `env` names nothing")
  if (entries.length > MAX_NAMES) {
    return refuse(`its \`env\` names ${String(entries.length)} variables, past the bound of ${String(MAX_NAMES)}`)
  }
  const env: Record<string, string> = {}
  for (const [name, value] of entries) {
    if (!NAME.test(name)) return refuse(`\`${name}\` is not a usable environment name`)
    if (name.startsWith("YRD_") || RESERVED.has(name)) {
      return refuse(`\`${name}\` is the queue's own statement about the tree and cannot be set by a check`)
    }
    if (typeof value !== "string") return refuse(`the value of \`${name}\` is not a string`)
    if (value.includes("\0") || value.includes("\n"))
      return refuse(`the value of \`${name}\` contains a control character`)
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) {
      return refuse(
        `the value of \`${name}\` is ${String(Buffer.byteLength(value))} bytes, past the ${String(MAX_VALUE_BYTES)}-byte bound`,
      )
    }
    env[name] = value
  }
  return { env, kind: "narrowed" }
}

/**
 * The same reading, off a check's log file: its last
 * {@link BASE_NARROWING_TAIL_BYTES}, because the line is written after the
 * check's own output and a check's log is not bounded.
 *
 * A log that cannot be read is a refusal and never an absence — the check ran,
 * so its log existing is the queue's own ground, and losing the offer in
 * silence is the same defect this whole file refuses.
 */
export async function narrowingOf(logPath: string): Promise<BaseNarrowing> {
  let file
  try {
    file = await open(logPath, "r")
  } catch (error) {
    return {
      kind: "refused",
      why: `${logPath} could not be opened: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  try {
    const { size } = await file.stat()
    const start = Math.max(0, size - BASE_NARROWING_TAIL_BYTES)
    const length = size - start
    if (length === 0) return { kind: "none" }
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, start)
    return readNarrowing(buffer.toString("utf8"))
  } catch (error) {
    return {
      kind: "refused",
      why: `${logPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    await file.close()
  }
}
