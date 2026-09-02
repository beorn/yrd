import { dirname } from "node:path"
import type { ChangeDeliveryState } from "@yrd/bay"
import type { FailureKind } from "@yrd/core"
import { canonicalRefusalCode, SUBMODULE_MODEL_CHANGE_PROP, type RefusalCode } from "@yrd/queue"
import { failureSlug } from "./failure-slug.ts"
import { heldQueueBase, quotedValue, refusalCure, refusedChange, type FailureEvidence } from "./refusal-cure.ts"
import { retainedWorkspaceFromMessage, type RetainedWorkspace } from "./workspace-retention.ts"

export type { FailureEvidence } from "./refusal-cure.ts"

export type FailureLike = Readonly<{
  code: string
  message: string
  resolution?: readonly string[]
  /**
   * Present exactly when this is a CLI-invocation failure fact (`raiseFailure`
   * / `createFailure`), absent on a durable `JobError`, which is the minimal
   * `{code,message}` pair. That difference is the whole discriminator this
   * projection needs: a durable code may be `<step-name>-failed` built from a
   * repo's configured plan, and a raised one never is.
   */
  kind?: FailureKind
}>

/** Who may authorize a refusal past, and the concrete act that does it.
 * `reason` names the authority; each step is one thing a person does — never a
 * command the runner may execute for them. */
export type FailureEscalation = Readonly<{ reason: string; steps: readonly string[] }>

/** Human-facing failure contract. Persisted failures remain the minimal
 * `{code,message}` pair; live audit evidence may additionally carry an exact
 * resolution that this projection preserves instead of parsing from prose. */
export type ActionableFailure = Readonly<{
  code: string
  cause: string
  /** Why the obvious move — retry, re-push, resubmit — does not clear this.
   * Printed unfiltered, like {@link FailureEscalation.reason}: for a refusal
   * the QUEUE recovers on its own the correct action is none, and a remedy
   * list cannot say that. */
  blocked?: string
  /** Where a reader SEES this failure for themselves: the artifact the refusal
   * is summarizing, or the command that prints the record. A refusal that
   * summarizes evidence without naming it leaves the reader to guess which of
   * several files it read (@i/10-yrd/refusals-name-their-cure). */
  evidence?: readonly FailureEvidence[]
  resolution: readonly string[]
  reference?: string
  /** Present when no mechanical remedy exists because at least one step needs
   * human judgment (a merge that can conflict). `resolution` then carries the
   * escalation itself, and these steps are guidance for the human who takes
   * it — never a machine-readable remedy to execute. */
  escalation?: FailureEscalation
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
    // `draft PRs are created with` was a fourth alternative here, carried for
    // one message that named `yrd pr create` — retired with the legacy record
    // mint (72c0282e). Its message now ends in `submit it with 'yrd ...'`, so
    // the general lead-in covers it and the message-specific literal is gone.
    /\s*[;,.]?\s*(?:(?:then\s+)?run|retry(?:\s+it)?\s+with|submit(?:\s+it)?\s+with)\s+['"`]yrd\s+[^'"`]+['"`].*$/iu,
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

/** The reviewer the producer already named in a rejection, so the escalation
 * points at the person who can reverse it rather than at "a reviewer". */
function rejectingReviewer(message: string): string {
  return /\bwas rejected by\s+(\S+?)(?=\s+for revision\b|[\s,;.]|$)/iu.exec(message)?.[1] ?? "<reviewer>"
}

const COMPONENT_MODEL_PROP_STEP =
  `Carry the ruling on a revision: --prop '${SUBMODULE_MODEL_CHANGE_PROP}=<add|remove> <path>; ` +
  `ruling <@cto-verdict-message-id>'`

/** One census entry: the sentence that replaces the false correct-and-retry
 * line, and the authority that may let this refusal through. */
type EscalationEntry = Readonly<{
  /** Why no retry of the same command can clear this — printed as the
   * `resolution`, per {@link ActionableFailure.escalation}'s contract that an
   * escalated failure's resolution IS the escalation, never a machine-readable
   * remedy. */
  blocked: string
  escalation: (message: string) => FailureEscalation
}>

/** The component-model arm of `authored-gitlink`, held as its own constant so
 * `authoredGitlinkFailure` — which routes before the flat census lookup — reads
 * the SAME entry the census below publishes, rather than a second copy of the
 * sentence that can drift from it. The ordinary generated-only-gitlink refusal
 * is NOT escalated: it names a cure (get the commit onto the component's own
 * main) the author performs themselves. */
const COMPONENT_MODEL_ESCALATION: EscalationEntry = {
  blocked:
    "Escalate the component-model addition or deletion; a gitlink bump only advances an existing " +
    "submodule, never adds or removes one.",
  escalation: () => ({
    reason:
      "@cto rules on the component model; a ruling authorizes this exact add or remove, and the queue admits " +
      "the change once the revision carries it.",
    steps: Object.freeze([
      "Ask @cto for a ruling naming the operation and the gitlink path; its verdict-message id is the authorization.",
      COMPONENT_MODEL_PROP_STEP,
    ]),
  }),
}

/**
 * THE ESCALATION CENSUS — every refusal a person with authority may
 * legitimately override, and nothing else (@i/10-yrd/escalation-channel-unused).
 *
 * ABSENCE IS THE POINT, and it is asserted. A refusal that prints no
 * `escalate:` line is claiming that NO override exists — a wall, not an unnamed
 * door. That claim is only worth reading if this table is complete for the
 * overridable cases, so `escalation-census.test.ts` walks the whole closed
 * `YRD_REFUSAL_CODES` vocabulary and proves every unlisted code renders none.
 *
 * MEMBERSHIP RULE: the caller cannot self-serve — the cure needs authority they
 * do not hold (a reviewer's approval, a @cto ruling, the hold owner's release)
 * or a host capability no retry of theirs can supply. A refusal that already
 * names a cure the author can perform stays OUT: `no-merge-authority` and
 * `min-commit-unpublished` both spell their own remedy, and an escalation
 * printed beside a remedy the reader can simply run is how this channel turns
 * into noise and stops being read.
 *
 * Keyed by {@link RefusalCode}, so an entry for a code the queue does not
 * register cannot compile, and a code retired from that vocabulary reddens
 * here instead of going quietly dead.
 */
const ESCALATION_CENSUS: Readonly<Partial<Record<RefusalCode, EscalationEntry>>> = {
  // Applied by authoredGitlinkFailure's component-model branch alone — the
  // flat lookup below never sees this code, because `actionableFailure` routes
  // it earlier. Listed here anyway: this table is the census, and a censused
  // code missing from it would be an override nothing records.
  "authored-gitlink": COMPONENT_MODEL_ESCALATION,
  // A ruling was carried and EVALUATED, and it did not cover this operation.
  // Bucketed needs-author, but the author's only move is to obtain someone
  // else's decision — resubmitting the same revision refuses identically.
  "component-model-authorization-refused": {
    blocked: "The carried ruling does not authorize this operation; the same revision will refuse identically.",
    escalation: () => ({
      reason: "Only @cto can widen or replace the ruling, and only a ruling naming THIS operation and path admits it.",
      steps: Object.freeze([
        "Ask @cto for a ruling covering the exact operation and path named in the cause above.",
        COMPONENT_MODEL_PROP_STEP,
      ]),
    }),
  },
  // Bucketed infra-retry, so the queue re-requeues it forever — and no retry
  // can ever clear it, because the missing thing is a capability of the HOST.
  // Exactly the class where silence reads as an absolute wall.
  "component-model-authorizer-unavailable": {
    blocked: "This Yrd host cannot resolve verdict messages, so no revision of this change can be authorized here.",
    escalation: () => ({
      reason:
        "The host operator owns the verdict-message resolver; until one is wired, the hh Yrd host is the host that " +
        "has it.",
      steps: Object.freeze([
        "Submit through the hh Yrd host, which resolves @cto verdict messages.",
        "Or ask this host's operator to configure a verdict-message resolver for it.",
      ]),
    }),
  },
  "review-required": {
    blocked: "Approval is another seat's act; no retry of this command can supply it.",
    escalation: (message) => ({
      reason: "A reviewer may approve this revision — the queue admits the change the moment one does.",
      steps: Object.freeze([
        `Reviewer runs: yrd pr review ${refusedChange(message)} --approve --by <reviewer>`,
        "The approval binds to the revision reviewed; a later push needs a fresh one.",
      ]),
    }),
  },
  "review-rejected": {
    blocked: "A rejection stands until its reviewer reverses it or a new revision replaces the one they read.",
    escalation: (message) => ({
      reason: `${rejectingReviewer(message)} rejected this revision and may approve it instead once the objection is answered.`,
      steps: Object.freeze([
        `${rejectingReviewer(message)} runs: yrd pr review ${refusedChange(message)} --approve --by ${rejectingReviewer(message)}`,
        "Or push a revision that answers the rejection, then ask for a fresh review.",
      ]),
    }),
  },
  // The hold is not this change's to lift, and its owner is not in the message
  // — the reason they recorded is, and that is what the reader escalates with.
  "queue-paused": {
    blocked: "A hold is not this change's to lift; retrying while it stands refuses identically.",
    escalation: (message) => ({
      reason:
        "Whoever declared the hold may admit this change through it or lift it; the reason they recorded is in the " +
        "cause above.",
      steps: Object.freeze([
        `Admit this one through by re-declaring the hold: yrd queue pause ${heldQueueBase(message)} --reason <why> --for <ttl> --allow ${refusedChange(message)}`,
        `Or lift the hold: yrd queue resume ${heldQueueBase(message)}`,
      ]),
    }),
  },
}

/** The census entry for a raw failure code, resolved through the queue's own
 * alias table first so an older spelling of a registered code escalates too. */
function escalationEntry(code: string): EscalationEntry | undefined {
  const canonical = canonicalRefusalCode(code)
  return canonical === undefined ? undefined : ESCALATION_CENSUS[canonical]
}

/** Project a censused refusal. Any `yrd ...` command embedded in the message is
 * deliberately dropped: an escalated failure has no mechanical remedy by
 * construction, `classifyRefusalRemedy` already short-circuits to `judgment` on
 * the escalation, and a mechanical line printed beside it would be dead text a
 * reader could waste a cycle running. */
function escalatedFailure(failure: FailureLike, cause: string, entry: EscalationEntry): ActionableFailure {
  return Object.freeze({
    code: failure.code,
    cause,
    resolution: Object.freeze([entry.blocked]),
    escalation: Object.freeze(entry.escalation(failure.message)),
  })
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
//
// The component-model branch is the ONE arm a person may authorize past, so it
// alone carries an escalation, sourced from the census below rather than kept
// as a second copy of the sentence. Its "Escalate the …" resolution named the
// act but never the authority, which is the whole defect the census closes: the
// gate that got this right once did it as hardcoded prose in one message
// (@i/10-yrd/escalation-channel-unused).
function authoredGitlinkFailure(failure: FailureLike, cause: string): ActionableFailure {
  const submodules = authoredGitlinkSubmodules(failure.message)
  const submoduleModelChange = failure.message.includes("a change of min commits advances existing submodules only")
  return Object.freeze({
    code: failure.code,
    cause,
    resolution: Object.freeze(
      submoduleModelChange
        ? [COMPONENT_MODEL_ESCALATION.blocked]
        : submodules.length > 0
          ? [
              "Get the named commit onto the component's own main first (see cause); " +
                "then resubmit: 'yrd pr submit <branch>'.",
            ]
          : [GENERIC_RESOLUTION],
    ),
    reference: "README.md#pr-eligibility-and-checks",
    ...(submoduleModelChange
      ? { escalation: Object.freeze(COMPONENT_MODEL_ESCALATION.escalation(failure.message)) }
      : {}),
  })
}

export function actionableFailure(failure: FailureLike): ActionableFailure {
  const cause = oneLineCause(failure.message)
  const retainedWorkspace = retainedWorkspaceFromMessage(failure.message)
  if (retainedWorkspace !== undefined || failure.code === "required-check-failed") {
    return retainedWorkspaceFailure(failure, cause, retainedWorkspace)
  }
  if (failure.code === "authored-gitlink") return authoredGitlinkFailure(failure, cause)
  // Before the generic tail: a censused refusal must never fall through to the
  // correct-and-retry line, which is FALSE for it — the cause is a decision
  // someone else has to make, and no retry reaches that decision.
  const entry = escalationEntry(failure.code)
  if (entry !== undefined) return escalatedFailure(failure, cause, entry)
  const commands = [...new Set([...(failure.resolution ?? []), ...embeddedYrdCommands(failure.message)])]
  // A registered cure, LAST before the generic tail: it exists precisely for
  // the codes whose own message carries no executable remedy, so anything the
  // message or a live audit already supplied wins over it (the census's
  // membership rule — a second copy of a cure is how the wrong one outlives
  // the fix to the first, fc6bd709).
  // The dynamic `<step-name>-failed` family is for DURABLE step results only.
  // A CLI-invocation failure carries a `kind`; a JobError never does — so the
  // presence of a kind is the fact that says "this code is not a step name",
  // and attaching by it is what stops a refusal about a typo'd issue id from
  // printing a cure about checks (the exit-3 boilerplate residue).
  const cure = refusalCure(failure.code, failure.message, { dynamicStepFamily: failure.kind === undefined })
  if (cure !== undefined) {
    const resolution = commands.length > 0 ? commands : cure.resolution
    return Object.freeze({
      code: failure.code,
      cause,
      ...(cure.blocked === undefined ? {} : { blocked: cure.blocked }),
      ...(cure.evidence.length === 0
        ? {}
        : { evidence: Object.freeze(cure.evidence.map((text) => Object.freeze({ text }))) }),
      // An empty remedy is the ANSWER for a queue-recovered refusal, not a
      // gap: `blocked` says so, and the census refuses an entry that has
      // neither. Never fall back to the generic correct-and-retry line here —
      // it is the false sentence this whole registry replaces.
      resolution: Object.freeze(resolution),
    })
  }
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

/** Cause → why the obvious move fails → where to see it → what to run. The
 * order a stopped reader needs, and the reason `blocked` precedes `evidence`:
 * a reader who learns the queue already owns the recovery stops reading, and
 * has lost nothing. */
function contextLines(failure: ActionableFailure): readonly string[] {
  return [
    ...(failure.blocked === undefined ? [] : [`blocked: ${failure.blocked}`]),
    ...(failure.evidence ?? []).map(({ text }) => `evidence: ${text}`),
  ]
}

export function formatActionableFailure(failure: ActionableFailure, prefix = ""): string {
  return [
    `${prefix}${errorCodeLabel(failure.code)}`,
    `cause: ${failure.cause}`,
    ...contextLines(failure),
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
    ...contextLines(failure),
    ...remedies.map((step) => `resolve: ${step}`),
    ...escalationLines(failure),
    ...(failure.reference === undefined ? [] : [`reference: ${failure.reference}`]),
  ].join("\n")
}
