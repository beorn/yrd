import { createProcess, type ProcessResult } from "@yrd/process"
import type { IssueResolver, QueueConfig } from "@yrd/queue-core"

export type ResolvedIssue = Readonly<{ id: string; status?: unknown }>

/** Fresh target-owned lookup; identity-only submission resolvers leave status unproven. */
export function issueLookup(
  config: QueueConfig,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): ((raw: string) => Promise<ResolvedIssue>) | undefined {
  const command = config.issueResolver
  if (command === undefined) return undefined
  return async (raw) => {
    if (raw.startsWith("-")) {
      throw new Error(
        `target .yrd.yml issueResolver raw issue reference ${JSON.stringify(raw)} starts with '-' and would be parsed as an option; no resolver command ran`,
      )
    }
    const argv = [...command, raw]
    const label = JSON.stringify(command)
    await using process = createProcess({ cwd, env })
    let result: ProcessResult
    try {
      result = await process.run({ argv, cwd, env, timeoutMs: 10_000 })
    } catch (cause) {
      throw new Error(
        `target .yrd.yml issueResolver ${label} could not run for ${JSON.stringify(raw)}: ${String(cause)}`,
        {
          cause,
        },
      )
    }
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.stalled ||
      result.escapedDescendant ||
      result.sweepFailure !== undefined ||
      result.outputTruncation !== undefined
    ) {
      throw new Error(
        `target .yrd.yml issueResolver ${label} failed for ${JSON.stringify(raw)}: ` +
          `exit ${result.exitCode}${result.timedOut ? ", timeout" : ""}${result.stalled ? ", stalled" : ""}` +
          `${result.sweepFailure === undefined ? "" : `, sweep: ${result.sweepFailure}`}; ${result.stderr.trim()}`,
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(result.stdout)
    } catch (cause) {
      throw new Error(`target .yrd.yml issueResolver ${label} returned invalid JSON for ${JSON.stringify(raw)}`, {
        cause,
      })
    }
    const id =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as { id?: unknown }).id
        : undefined
    if (typeof id !== "string" || id.trim() === "" || id !== id.trim() || /[\u0000-\u001f\u007f]/u.test(id)) {
      throw new Error(`target .yrd.yml issueResolver ${label} returned no canonical id for ${JSON.stringify(raw)}`)
    }
    const status = (payload as { status?: unknown }).status
    return { id, ...(status === undefined ? {} : { status }) }
  }
}

/**
 * Resolve many raw references in one target-resolver invocation. A batch-aware
 * resolver returns a JSON array aligned with the arguments, using null for a
 * reference with no canonical issue. A legacy resolver that returns the
 * single-reference object is reported as undefined so callers can use the
 * single-reference form without guessing which result it answered.
 */
export function issueLookupBatch(
  config: QueueConfig,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): ((raws: readonly string[]) => Promise<ReadonlyMap<string, ResolvedIssue> | undefined>) | undefined {
  const command = config.issueResolver
  if (command === undefined) return undefined
  return async (raws) => {
    for (const raw of raws) {
      if (raw.startsWith("-")) {
        throw new Error(
          `target .yrd.yml issueResolver raw issue reference ${JSON.stringify(raw)} starts with '-' and would be parsed as an option; no resolver command ran`,
        )
      }
    }
    if (raws.length === 0) return new Map()
    const argv = [...command, ...raws]
    const label = JSON.stringify(command)
    await using process = createProcess({ cwd, env })
    let result: ProcessResult
    try {
      result = await process.run({ argv, cwd, env, timeoutMs: 10_000 })
    } catch (cause) {
      throw new Error(
        `target .yrd.yml issueResolver ${label} could not run for ${raws.length} issue references: ${String(cause)}`,
        { cause },
      )
    }
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.stalled ||
      result.escapedDescendant ||
      result.sweepFailure !== undefined ||
      result.outputTruncation !== undefined
    ) {
      throw new Error(
        `target .yrd.yml issueResolver ${label} failed for ${raws.length} issue references: ` +
          `exit ${result.exitCode}${result.timedOut ? ", timeout" : ""}${result.stalled ? ", stalled" : ""}` +
          `${result.sweepFailure === undefined ? "" : `, sweep: ${result.sweepFailure}`}; ${result.stderr.trim()}`,
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(result.stdout)
    } catch (cause) {
      throw new Error(
        `target .yrd.yml issueResolver ${label} returned invalid JSON for ${raws.length} issue references`,
        { cause },
      )
    }
    if (!Array.isArray(payload)) {
      if (typeof payload === "object" && payload !== null) return undefined
      throw new Error(
        `target .yrd.yml issueResolver ${label} returned invalid batch JSON for ${raws.length} issue references`,
      )
    }
    if (payload.length !== raws.length) {
      throw new Error(
        `target .yrd.yml issueResolver ${label} returned ${payload.length} batch results for ${raws.length} issue references`,
      )
    }
    const resolved = new Map<string, ResolvedIssue>()
    for (const [index, raw] of raws.entries()) {
      const entry: unknown = payload[index]
      if (entry === null) continue
      if (typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `target .yrd.yml issueResolver ${label} returned invalid batch result for ${JSON.stringify(raw)}`,
        )
      }
      const id = (entry as { id?: unknown }).id
      if (typeof id !== "string" || id.trim() === "" || id !== id.trim() || /[\u0000-\u001f\u007f]/u.test(id)) {
        throw new Error(`target .yrd.yml issueResolver ${label} returned no canonical id for ${JSON.stringify(raw)}`)
      }
      const status = (entry as { status?: unknown }).status
      resolved.set(raw, { id, ...(status === undefined ? {} : { status }) })
    }
    return resolved
  }
}

/** Cache identity only; cleanup uses the same lookup without caching closure status. */
export function issueResolver(config: QueueConfig, cwd: string, env?: NodeJS.ProcessEnv): IssueResolver | undefined {
  const lookup = issueLookup(config, cwd, env)
  if (lookup === undefined) return undefined
  const cache = new Map<string, Promise<string>>()
  return (raw) => {
    const cached = cache.get(raw)
    if (cached !== undefined) return cached
    const pending = lookup(raw).then(({ id }) => id)
    cache.set(raw, pending)
    return pending
  }
}
