import { dirname } from "node:path"
import type { ChangeDeliveryState } from "@yrd/bay"
import { failureSlug } from "./failure-slug.ts"
import { retainedWorkspaceFromMessage, type RetainedWorkspace } from "./workspace-retention.ts"

export type FailureLike = Readonly<{ code: string; message: string; resolution?: readonly string[] }>

/** Human-facing failure contract. Persisted failures remain the minimal
 * `{code,message}` pair; live audit evidence may additionally carry an exact
 * resolution that this projection preserves instead of parsing from prose. */
export type ActionableFailure = Readonly<{
  code: string
  cause: string
  resolution: readonly string[]
  reference?: string
  /** Present when no mechanical remedy exists because at least one step needs
   * human judgment (a merge that can conflict). `resolution` then carries the
   * escalation itself, and these steps are guidance for the human who takes
   * it — never a machine-readable remedy to execute. */
  escalation?: Readonly<{ reason: string; steps: readonly string[] }>
}>

/** What the projection knows about the change the failure belongs to. `resolution`
 * is the only machine-readable remedy channel, so a step the change's current
 * delivery state refuses is a wrong instruction, not a hint (22396). Callers
 * that hold the change thread its state; callers that do not get the remedy no
 * state refuses. */
const GENERIC_RESOLUTION = "Correct the cause above, then retry the same Yrd command."

function oneLineCause(message: string): string {
  const normalized = message
    .replace(/^(?:(?:yrd|error):\s*)+/iu, "")
    .replace(/\s+/gu, " ")
    .trim()
  const withoutRemedy = normalized.replace(
    /\s*[;,.]?\s*(?:(?:then\s+)?run|retry(?:\s+it)?\s+with|submit(?:\s+it)?\s+with|draft\s+PRs\s+are\s+created\s+with)\s+['"`]yrd\s+[^'"`]+['"`].*$/iu,
    "",
  )
  const [cause = withoutRemedy] = withoutRemedy.split(/\s+hint:\s*/iu, 1)
  return cause.replace(/[.;:\s]+$/u, "") || "Yrd could not complete the request"
}

function embeddedYrdCommands(message: string): string[] {
  const commands: string[] = []
  for (const match of message.matchAll(/['"`](yrd\s+[^'"`]+)['"`]/giu)) {
    const command = match[1]?.trim()
    if (command !== undefined && !commands.includes(command)) commands.push(command)
  }
  return commands
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function retainedWorkspaceFailure(
  failure: FailureLike,
  cause: string,
  workspace: RetainedWorkspace | undefined,
): ActionableFailure {
  const check = quotedValue(failure.message, /required check failed:\s*'([^']+)'/iu)
  const resolution = [
    ...(workspace === undefined
      ? []
      : [
          `Inspect the retained workspace at ${shellQuote(workspace.path)}.`,
          ...(workspace.cleanup === "worktree"
            ? [
                `git worktree remove --force ${shellQuote(workspace.path)}`,
                `rmdir ${shellQuote(dirname(workspace.path))}`,
              ]
            : [`rmdir ${shellQuote(workspace.path)}`]),
        ]),
    ...(check === undefined ? ["yrd pr submit <branch>"] : [`yrd check ${shellQuote(check)}`]),
  ]
  return Object.freeze({
    code: failure.code,
    cause,
    resolution: Object.freeze(resolution.length === 0 ? [GENERIC_RESOLUTION] : resolution),
  })
}

function quotedValue(message: string, pattern: RegExp): string | undefined {
  return pattern.exec(message)?.[1]
}

/** Mechanical redelivery refuses a terminal change outright: an
 * integrated/already-landed identity is frozen evidence, and reopening a
 * withdrawn/canceled delivery by resubmitting its branch is a human act the
 * runner must never take on its own. */
const REDELIVERY_REFUSING_STATES: ReadonlySet<ChangeDeliveryState> = new Set<ChangeDeliveryState>([
  "integrated",
  "already-landed",
  "withdrawn",
  "canceled",
])

/** Whether mechanical redelivery is refused outright by this delivery state.
 * The one home for the fact, so a caller that decides whether a printed remedy
 * can be applied mechanically reads the same answer the printer used. */
export function redeliveryRefusedByDelivery(delivery: ChangeDeliveryState | undefined): boolean {
  return delivery !== undefined && REDELIVERY_REFUSING_STATES.has(delivery)
}

function authoredGitlinkSubmodules(message: string): readonly string[] {
  const raw = /generated-only gitlinks \[([^\]]*)\]/iu.exec(message)?.[1]
  return raw === undefined
    ? []
    : raw
        .split(",")
        .map((path) => path.trim())
        .filter(Boolean)
}

// Advancing a submodule min commit is an ordinary change: fast-forward the submodule's own
// main to the target commit, then submit the root branch like any other
// change — the queue fills the shaset in itself. `yrd intent submit`, the
// mechanical per-submodule verb this used to print, is retired (23000).
//
// The fast-forward step is intentionally NOT constructed here as a literal
// hand-push command: remedy-banned-actions-guard.test.ts bans printing a raw
// git-push-to-a-submodule's-branch-ref line anywhere in this tool surface,
// because that instruction is real advice only for a landing:none vendor
// submodule and wrong everywhere else this projection is reused — a
// distinction no static remedy string can carry. `intentSubmissionWorkflow`
// (yrd-queue/src/command.ts) already says "get commit onto main" as prose in
// the failure message itself, and `oneLineCause` already preserves that
// prose into `cause` untouched (no quoted 'yrd ...' command follows it, so
// nothing strips it) — so it is surfaced for free, without this function
// re-deriving or discarding it.
//
// The resolution is deliberately PROSE, not a bare mechanical command line: a
// bare `yrd pr submit <branch>` resolution now means "the runner may apply
// this itself" (the retired recut spelling's replacement drill), and the pin
// fast-forward is author-owned work that must happen FIRST — resubmitting the
// unchanged branch would just refuse again. The fallback spelling rides
// inside the prose for the human who has done the pin work.
function authoredGitlinkFailure(failure: FailureLike, cause: string): ActionableFailure {
  const submodules = authoredGitlinkSubmodules(failure.message)
  const submoduleModelChange = failure.message.includes("a change of min commits advances existing submodules only")
  return Object.freeze({
    code: failure.code,
    cause,
    resolution: Object.freeze(
      submoduleModelChange
        ? [
            "Escalate the component-model addition or deletion; a gitlink bump only advances an existing " +
              "submodule, never adds or removes one.",
          ]
        : submodules.length > 0
          ? [
              "Get the named commit onto the component's own main first (see cause); " +
                "then resubmit: 'yrd pr submit <branch>'.",
            ]
          : [GENERIC_RESOLUTION],
    ),
    reference: "README.md#pr-eligibility-and-checks",
  })
}

export function actionableFailure(failure: FailureLike): ActionableFailure {
  const cause = oneLineCause(failure.message)
  const retainedWorkspace = retainedWorkspaceFromMessage(failure.message)
  if (retainedWorkspace !== undefined || failure.code === "required-check-failed") {
    return retainedWorkspaceFailure(failure, cause, retainedWorkspace)
  }
  if (failure.code === "authored-gitlink") return authoredGitlinkFailure(failure, cause)
  const commands = [...new Set([...(failure.resolution ?? []), ...embeddedYrdCommands(failure.message)])]
  return Object.freeze({
    code: failure.code,
    cause,
    resolution: Object.freeze(commands.length === 0 ? [GENERIC_RESOLUTION] : commands),
  })
}

export function errorCodeLabel(code: string): string {
  return `err=${failureSlug(code)}`
}

export function actionableFailureSummary(failure: ActionableFailure): string {
  return `${errorCodeLabel(failure.code)} — ${failure.cause}`
}

function escalationLines(failure: ActionableFailure): readonly string[] {
  if (failure.escalation === undefined) return []
  return [`escalate: ${failure.escalation.reason}`, ...failure.escalation.steps.map((step) => `manual: ${step}`)]
}

export function formatActionableFailure(failure: ActionableFailure, prefix = ""): string {
  return [
    `${prefix}${errorCodeLabel(failure.code)}`,
    `cause: ${failure.cause}`,
    ...failure.resolution.map((step) => `resolve: ${step}`),
    ...escalationLines(failure),
    ...(failure.reference === undefined ? [] : [`reference: ${failure.reference}`]),
  ].join("\n")
}

/** Concise human projection. The structured code/cause/resolution envelope is
 * retained for JSON and persisted views; an ordinary CLI error leads with the
 * complete sentence and only keeps remedies that add information. An escalated
 * failure has no executable remedy by construction — its resolution IS the
 * escalation sentence — so it is kept verbatim rather than filtered away. */
export function formatHumanFailure(failure: ActionableFailure): string {
  const remedies =
    failure.escalation === undefined
      ? failure.resolution.filter((step) => /^(?:Inspect\b|Get\b|Escalate\b|git\s|rmdir\s|yrd\s)/u.test(step))
      : failure.resolution
  return [
    `error: ${failure.cause}`,
    ...remedies.map((step) => `resolve: ${step}`),
    ...escalationLines(failure),
    ...(failure.reference === undefined ? [] : [`reference: ${failure.reference}`]),
  ].join("\n")
}
