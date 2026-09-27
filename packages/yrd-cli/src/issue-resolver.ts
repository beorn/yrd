import { createProcess, type ProcessResult } from "@yrd/process"
import type { IssueResolver, QueueConfig } from "@yrd/queue-core"

/** Execute only the target declaration's resolver; its JSON result names the canonical issue. */
export function issueResolver(config: QueueConfig, cwd: string, env?: NodeJS.ProcessEnv): IssueResolver | undefined {
  const command = config.issueResolver
  if (command === undefined) return undefined
  const cache = new Map<string, Promise<string>>()
  return (raw) => {
    let pending = cache.get(raw)
    if (pending !== undefined) return pending
    pending = (async () => {
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
      return id
    })()
    cache.set(raw, pending)
    return pending
  }
}
