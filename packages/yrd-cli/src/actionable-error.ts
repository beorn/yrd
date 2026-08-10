import { dirname } from "node:path"
import type { PRDeliveryState } from "@yrd/bay"
import { failureSlug } from "./failure-slug.ts"

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

/** What the projection knows about the PR the failure belongs to. `resolution`
 * is the only machine-readable remedy channel, so a step the PR's current
 * delivery state refuses is a wrong instruction, not a hint (22396). Callers
 * that hold the PR thread its state; callers that do not get the remedy no
 * state refuses. */
export type ActionableFailureContext = Readonly<{ delivery?: PRDeliveryState }>

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

function requiredCheckFailure(failure: FailureLike, cause: string): ActionableFailure {
  const check = quotedValue(failure.message, /required check failed:\s*'([^']+)'/iu)
  const workspace = quotedValue(failure.message, /workspace retained at '([^']+)'/iu)
  const resolution = [
    ...(workspace === undefined
      ? []
      : [
          `Inspect the retained workspace at ${shellQuote(workspace)}.`,
          `git worktree remove --force ${shellQuote(workspace)}`,
          `rmdir ${shellQuote(dirname(workspace))}`,
        ]),
    ...(check === undefined ? [] : [`yrd check ${shellQuote(check)}`]),
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

function prId(message: string): string | undefined {
  return quotedValue(message, /\bPR\s+'([^']+)'/iu)
}

/** `yrd pr recut` refuses a terminal PR outright (`terminal-target`): an
 * integrated/already-landed identity is frozen evidence and a
 * withdrawn/canceled one is reopened by resubmitting its branch, not recut. */
const RECUT_REFUSING_STATES: ReadonlySet<PRDeliveryState> = new Set<PRDeliveryState>([
  "integrated",
  "already-landed",
  "withdrawn",
  "canceled",
])

/** Whether `yrd pr recut` is refused outright by this delivery state. The one
 * home for the fact, so a caller that decides whether a printed remedy can be
 * applied mechanically reads the same answer the printer used. */
export function recutRefusedByDelivery(delivery: PRDeliveryState | undefined): boolean {
  return delivery !== undefined && RECUT_REFUSING_STATES.has(delivery)
}

/** Re-record the branch's corrected head onto the PR.
 *
 * `yrd pr create <branch>` is accepted only for a draft (pushed) PR — the
 * create path guards the delivery state twice and refuses every other one — so
 * it is emitted only when the projection positively knows the PR is a draft,
 * where it is preferable because it keeps the PR a draft. `yrd pr submit
 * <branch>` is refused by no delivery state (a pushed draft is submitted, a
 * submitted/needs-author PR records a fresh revision, a rejected one resumes,
 * a withdrawn/canceled one reopens, and a landed branch mints a fresh
 * delivery), so it is also the safe answer when the state is unknown. */
function recordCommand(delivery: PRDeliveryState | undefined): string {
  return delivery === "pushed" ? "yrd pr create <branch>" : "yrd pr submit <branch>"
}

function recutSteps(pr: string, delivery: PRDeliveryState | undefined): readonly string[] {
  if (recutRefusedByDelivery(delivery)) return []
  return [`yrd pr recut ${pr} --preflight --queue`]
}

function redeliverySteps(pr: string, delivery: PRDeliveryState | undefined): readonly string[] {
  return [recordCommand(delivery), ...recutSteps(pr, delivery)]
}

function authoredGitlinkFailure(
  failure: FailureLike,
  cause: string,
  context: ActionableFailureContext,
): ActionableFailure {
  const pr = prId(failure.message) ?? "<PR>"
  return Object.freeze({
    code: failure.code,
    cause,
    resolution: Object.freeze(redeliverySteps(pr, context.delivery)),
    reference: "README.md#pr-eligibility-and-checks",
  })
}

function recutGitlinkFailure(
  failure: FailureLike,
  cause: string,
  context: ActionableFailureContext,
): ActionableFailure | undefined {
  const pr = prId(failure.message)
  const path = quotedValue(failure.message, /pins\s+submodule\s+'([^']+)'\s+to/iu)
  const basePin = quotedValue(
    failure.message,
    /target\s+root\s+'[^']+'\s+pins\s+submodule\s+'[^']+'\s+to\s+'([^']+)'/iu,
  )
  const authoredPin = quotedValue(
    failure.message,
    /replayed\s+authored\s+root\s+'[^']+'\s+pins\s+(?:it|submodule\s+'[^']+')\s+to\s+'([^']+)'/iu,
  )
  if (pr === undefined || path === undefined || basePin === undefined || authoredPin === undefined) return undefined
  // The compose recipe is NOT a mechanical remedy: its merge step composes two
  // divergent submodule pins and can conflict, and resolving that conflict is a
  // judgment call. `resolution` — the machine-readable channel — therefore
  // carries the escalation, and the recipe rides `escalation.steps` as guidance
  // for the human who takes it (22396).
  return Object.freeze({
    code: failure.code,
    cause,
    resolution: Object.freeze([
      `Escalate to a human: composing '${path}' from authored pin '${authoredPin}' onto base pin '${basePin}' ` +
        "needs merge-conflict judgment; do not run the recipe mechanically.",
    ]),
    escalation: Object.freeze({
      reason:
        `git -C ${path} merge ${basePin} composes two divergent submodule pins and can conflict; ` +
        "conflict resolution is judgment, not a mechanical step.",
      steps: Object.freeze([
        `git -C ${path} fetch --all --prune`,
        `git -C ${path} switch -c yrd/compose-${pr} ${authoredPin}`,
        `git -C ${path} merge ${basePin}`,
        `git -C ${path} push -u origin HEAD`,
        `git add ${path} && git commit -m "fix(yrd): compose ${path} pins"`,
        ...redeliverySteps(pr, context.delivery),
      ]),
    }),
    reference: "README.md#resolving-divergent-gitlink-pins",
  })
}

export function actionableFailure(failure: FailureLike, context: ActionableFailureContext = {}): ActionableFailure {
  const cause = oneLineCause(failure.message)
  if (failure.code === "required-check-failed") return requiredCheckFailure(failure, cause)
  if (failure.code === "authored-gitlink") return authoredGitlinkFailure(failure, cause, context)
  if (failure.code === "recut-gitlink-conflict") {
    const projected = recutGitlinkFailure(failure, cause, context)
    if (projected !== undefined) return projected
  }
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
      ? failure.resolution.filter((step) => /^(?:Inspect\b|git\s|rmdir\s|yrd\s)/u.test(step))
      : failure.resolution
  return [
    `error: ${failure.cause}`,
    ...remedies.map((step) => `resolve: ${step}`),
    ...escalationLines(failure),
    ...(failure.reference === undefined ? [] : [`reference: ${failure.reference}`]),
  ].join("\n")
}
