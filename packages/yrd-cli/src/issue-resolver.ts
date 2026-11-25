import { runIssuesVerb } from "./issues/run.ts"

/**
 * The issue read's bound (resolve for env open/submit, view for env status/cleanup, sameness): a provider still
 * running at 30 s is killed and named. 10 s failed every `km bd resolve` at host load 60+ (5.6 s measured direct,
 * @chief c0ce760a), so `yrd env open --issue` and `yrd submit --issue` refused healthy issues.
 */
export const ISSUE_DISPLAY_TIMEOUT_MS = 30_000

/**
 * Display transport only: provider keys and payloads have no Yrd issue semantics. The read is the issues
 * interface's `view`, run in-process through `runIssuesVerb` against the project root's `issues.yml`
 * (@cto rulings 0e9e794e / b59e0e09); it no longer runs `.yrd.yml`'s `issuesProvider.read`.
 */
export async function readIssueDisplay(
  input: Readonly<{
    key: string
    /** The project whose `issues.yml` declares `view`. */
    projectRoot: string
    /** Where the provider runs. */
    cwd: string
    env?: NodeJS.ProcessEnv
    /** Where the provider's stderr passes through. */
    stderr?: (text: string) => void
    timeoutMs?: number
  }>,
): Promise<Readonly<{ available: true; data: unknown } | { available: false; reason: string }>> {
  try {
    const outcome = await runIssuesVerb({
      verb: "view",
      args: [input.key],
      projectRoot: input.projectRoot,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? ISSUE_DISPLAY_TIMEOUT_MS,
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.stderr === undefined ? {} : { stderr: input.stderr }),
    })
    return outcome.ok
      ? { available: true, data: outcome.envelope.result }
      : { available: false, reason: `issue info unavailable: ${outcome.message}` }
  } catch (error) {
    // A reader fault (not a provider's) still only costs the decoration, and says why.
    return {
      available: false,
      reason: `issue info unavailable: view ${JSON.stringify(input.key)}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
