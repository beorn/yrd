import { createProcess, type ProcessResult } from "@yrd/process"
import type { IssueResolver, QueueConfig } from "@yrd/queue-core"

export type ResolvedIssue = Readonly<{ id: string; status?: unknown }>

/** Run the declared resolver once over `raws` and return its parsed JSON; every failure names the command and the raws. */
async function runIssueResolver(
  command: readonly string[],
  raws: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<unknown> {
  const shown = raws.length === 1 ? JSON.stringify(raws[0]) : `${raws.length} issue references`
  for (const raw of raws) {
    if (raw.startsWith("-")) {
      throw new Error(
        `target .yrd.yml issueResolver raw issue reference ${JSON.stringify(raw)} starts with '-' and would be parsed as an option; no resolver command ran`,
      )
    }
  }
  const argv = [...command, ...raws]
  const label = JSON.stringify(command)
  await using process = createProcess({ cwd, env })
  let result: ProcessResult
  try {
    result = await process.run({ argv, cwd, env, timeoutMs: 10_000 })
  } catch (cause) {
    throw new Error(`target .yrd.yml issueResolver ${label} could not run for ${shown}: ${String(cause)}`, {
      cause,
    })
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
      `target .yrd.yml issueResolver ${label} failed for ${shown}: ` +
        `exit ${result.exitCode}${result.timedOut ? ", timeout" : ""}${result.stalled ? ", stalled" : ""}` +
        `${result.sweepFailure === undefined ? "" : `, sweep: ${result.sweepFailure}`}; ${result.stderr.trim()}`,
    )
  }
  try {
    return JSON.parse(result.stdout)
  } catch (cause) {
    throw new Error(`target .yrd.yml issueResolver ${label} returned invalid JSON for ${shown}`, { cause })
  }
}

/** One resolver object → a resolved issue, or a thrown error naming what was wrong with it. */
function resolvedIssueOf(payload: unknown, label: string, raw: string): ResolvedIssue {
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

/** Fresh target-owned lookup; identity-only submission resolvers leave status unproven. */
export function issueLookup(
  config: QueueConfig,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): ((raw: string) => Promise<ResolvedIssue>) | undefined {
  const command = config.issueResolver
  if (command === undefined) return undefined
  return async (raw) => resolvedIssueOf(await runIssueResolver(command, [raw], cwd, env), JSON.stringify(command), raw)
}

/**
 * One resolver run over several issue references (29450): the declared command receives every raw as a
 * positional argument and answers a JSON array of the same length, one object (`{id, status}`) or `null`
 * (no single issue bound) per raw, in order. A command that answers anything else fails the whole lookup,
 * and the caller treats that as unknown, never as closed.
 */
export function issueLookupMany(
  config: QueueConfig,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): ((raws: readonly string[]) => Promise<readonly (ResolvedIssue | null)[]>) | undefined {
  const command = config.issueResolver
  if (command === undefined) return undefined
  const label = JSON.stringify(command)
  return async (raws) => {
    if (raws.length === 0) return []
    const payload = await runIssueResolver(command, raws, cwd, env)
    if (!Array.isArray(payload) || payload.length !== raws.length) {
      throw new Error(
        `target .yrd.yml issueResolver ${label} answered ${raws.length} issue references with ${
          Array.isArray(payload) ? `${payload.length} entries` : "a non-array"
        }; expected one entry per reference`,
      )
    }
    return payload.map((entry, index) => (entry === null ? null : resolvedIssueOf(entry, label, raws[index] ?? "")))
  }
}

/** Cache canonical identity for submission. */
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
