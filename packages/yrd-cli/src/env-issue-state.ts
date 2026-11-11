import { runIssuesVerb } from "./issues/run.ts"

/**
 * What an environment's recorded issue says about releasing it (33170, disk rule 3). Only a provider answer of
 * exactly `closed` or `dropped` releases; every other outcome — a provider error, an unknown id, a missing or
 * different status — is a keep with its reason named, never a guess (@cto 1a7a3153 condition 1).
 */
export type EnvIssueState =
  | Readonly<{ kind: "closed" | "dropped"; issue: string }>
  | Readonly<{ kind: "keep"; reason: string; unreadable?: true }>

/**
 * The state is read through the project's own issues interface (`issues.yml` `view`), the same provider every
 * other Yrd issue read uses, at sweep time; the environment never stores a copy of it.
 */
export async function readEnvIssueState(
  input: Readonly<{ issue: string; projectRoot: string; cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }>,
): Promise<EnvIssueState> {
  const named = JSON.stringify(input.issue)
  try {
    const outcome = await runIssuesVerb({
      verb: "view",
      args: [input.issue],
      projectRoot: input.projectRoot,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      ...(input.env === undefined ? {} : { env: input.env }),
      stderr: () => {},
    })
    if (!outcome.ok) {
      return { kind: "keep", reason: `issue ${named} state unreadable: ${outcome.message}`, unreadable: true }
    }
    const result: unknown = outcome.envelope.result
    const status =
      typeof result === "object" && result !== null && "status" in result
        ? (result as { status: unknown }).status
        : undefined
    if (status === "closed" || status === "dropped") return { kind: status, issue: input.issue }
    if (typeof status !== "string") {
      return { kind: "keep", reason: `issue ${named} has no status in its provider answer`, unreadable: true }
    }
    return { kind: "keep", reason: `issue ${named} is ${status}, not closed or dropped` }
  } catch (cause) {
    return {
      kind: "keep",
      reason: `issue ${named} state unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
      unreadable: true,
    }
  }
}
