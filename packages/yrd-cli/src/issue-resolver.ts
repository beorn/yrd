import { createProcess } from "@yrd/process"

/** Display transport only: provider keys and payloads have no Yrd issue semantics. */
export async function readIssueDisplay(
  command: readonly string[],
  key: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<Readonly<{ available: true; data: unknown } | { available: false; reason: string }>> {
  const argv = command.map((part) => (part === "<key>" ? key : part))
  const label = "issuesProvider.read " + JSON.stringify(command) + " for " + JSON.stringify(key)
  await using process = createProcess({ cwd, env })
  try {
    const result = await process.run({ argv, cwd, timeoutMs: 10_000 })
    if (
      result.exitCode !== 0 ||
      result.signal !== null ||
      result.timedOut ||
      result.stalled ||
      result.escapedDescendant ||
      result.sweepFailure !== undefined ||
      result.outputTruncation !== undefined
    ) {
      return {
        available: false,
        reason:
          "issue info unavailable: " +
          label +
          ": exit " +
          result.exitCode +
          ", signal " +
          result.signal +
          ", timeout " +
          result.timedOut +
          "; " +
          result.stderr.trim(),
      }
    }
    try {
      return { available: true, data: JSON.parse(result.stdout) }
    } catch {
      return { available: false, reason: "issue info unavailable: " + label + ": invalid JSON" }
    }
  } catch (error) {
    return { available: false, reason: "issue info unavailable: " + label + ": " + String(error) }
  }
}
