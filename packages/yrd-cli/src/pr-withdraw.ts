import { adaptProcessGit, createProcess, type GitSyncReadCommand } from "@yrd/process"
import type { GitProcessResult } from "git-super/process"
import { createElement } from "react"
import {
  currentChangeRev,
  isLiveChange,
  changeDeliveryState,
  changeNeedsAuthor,
  changeNotFoundMessage,
  type Change,
} from "@yrd/bay"
import { raiseFailure } from "@yrd/core"
import { Queues, type Run } from "@yrd/queue"
import { usage } from "./invocation.ts"
import { printResult } from "./output.tsx"
import { ChangeResultView } from "./queue-status-view.tsx"
import { projectChangeTaskStatus } from "./task-status.ts"
import type { PruneGitFacts, YrdCliApp, YrdCliIO } from "./types.ts"

type JsonOption = Readonly<{ json?: boolean }>

const DEFAULT_WITHDRAW_REASON = "PR withdrawn"
const GIT_TIMEOUT_MS = 30_000
/** Commits per `rev-list` invocation, so a listing with thousands of candidate
 * heads cannot overflow the argument vector. */
const REV_LIST_BATCH = 400
const CONSUMED_QUEUE_AUTHORITY_RESULTS = new Set(["queue-submit-authority-consumed", "queue-checks-authority-consumed"])

function jsonEnabled(options: JsonOption): boolean {
  return options.json === true
}

function short(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha
}

/** Resolve one live change or raise the typed refusal that names why it cannot be
 * withdrawn. An unknown selector and a terminal change are both loud failures —
 * never a silent no-op. */
function requiredLivePr(app: YrdCliApp, selector: string): Change {
  const pr = app.bays.pr(selector)
  if (pr === undefined) {
    raiseFailure("refusal", "pr-missing", changeNotFoundMessage(app.state().bays, selector))
  }
  const delivery = changeDeliveryState(pr)
  if (!isLiveChange(pr)) {
    raiseFailure(
      "refusal",
      "pr-terminal",
      `yrd: change '${pr.id}' is ${delivery}; a terminal change cannot be withdrawn`,
    )
  }
  return pr as Change
}

/** Withdraw the selected live change revision: emit pr/withdrawn with the recorded
 * reason and terminalize any Queue work still holding that authority.
 *
 * Exported because the habitant sweeps a change whose source branch is gone from
 * origin through this exact act (`run.ts`, @yrd/core/deleted-branch-head-wedges-queue)
 * — one withdrawal mechanism, not a second one that could terminalize differently.
 * The `--burn-payload` acknowledgement `withdrawPrs` demands is an OPERATOR gate on
 * spending a payload that still exists; a branch origin no longer advertises has no
 * payload left to spend, and the reason recorded here is the proof. */
export async function withdrawOne(
  app: YrdCliApp,
  id: string,
  reason: string | undefined,
  io: YrdCliIO,
): Promise<Change> {
  await app.bays.closePr({ pr: id, ...(reason === undefined ? {} : { reason }) })
  const withdrawn = app.bays.pr(id)
  if (withdrawn === undefined) throw new Error(`yrd: change '${id}' disappeared after withdraw`)
  await app.queue.cancel({ prs: [id], by: io.runner ?? "operator", reason: reason ?? DEFAULT_WITHDRAW_REASON })
  return withdrawn as Change
}

/** What closing this revision spends, in the operator's own terms: the exact
 * revision leaving delivery — so an operator acting on a STALE read sees the
 * mismatch here, before the spend, not after it (the PR78 specimen) — and the
 * one command that brings the payload back. */
type PayloadSpend = Readonly<{ pr: string; revision: number; headSha: string; branch: string; reopen: string }>

function payloadSpend(pr: Change): PayloadSpend {
  const revision = currentChangeRev(pr)
  return {
    pr: pr.id,
    revision: revision.n,
    headSha: revision.head,
    branch: pr.branch,
    reopen: `yrd pr submit ${pr.branch}`,
  }
}

function spendLine(spend: PayloadSpend): string {
  return `${spend.pr} r${spend.revision} head ${spend.headSha} on '${spend.branch}'`
}

/** Closing an unmerged change is not housekeeping: it spends the
 * payload identity, and every other branch is barred from that commit
 * afterwards. The verb reads reversible, so the spend is stated and
 * acknowledged BEFORE the first event — never a silent success. The
 * acknowledgement is an explicit flag, not a prompt, so a non-TTY caller gets
 * the same typed refusal instead of hanging. */
function refuseUnacknowledgedSpend(verb: string, spends: readonly PayloadSpend[]): never {
  raiseFailure(
    "refusal",
    "withdraw-unacknowledged",
    `yrd: ${verb} spends payload identity permanently — ${spends.map(spendLine).join("; ")}; ` +
      "a closed commit can never be resubmitted as-is on any other branch, and only its own branch reopens it. " +
      "Re-read each revision above, then pass --burn-payload to acknowledge the spend.",
  )
}

export type WithdrawPrsOptions = JsonOption & Readonly<{ reason?: string; burnPayload?: boolean }>

/** `yrd change withdraw <selector...> --burn-payload [--reason <text>]` —
 * withdraw live PRs, recording the operator's reason on each pr/withdrawn
 * event. Every selector is validated, and the whole spend disclosed and
 * acknowledged, before the first event is emitted, so a mixed batch refuses
 * whole.
 *
 * `change close` and the hidden `withdraw` alias are ONE act: the withdrawn
 * record with its reason is written FIRST, then queue work terminalizes — a
 * close that fails partway still leaves the reason behind. Only the printed
 * envelope name follows the invoked spelling. */
export async function withdrawPrs(
  app: YrdCliApp,
  selectors: readonly string[],
  options: WithdrawPrsOptions,
  io: YrdCliIO,
  command: "pr.close" | "pr.withdraw" = "pr.withdraw",
): Promise<void> {
  const verb = command === "pr.close" ? "change close" : "change withdraw"
  if (selectors.length === 0) usage(`${verb} requires at least one change selector`)
  const reason = options.reason?.trim()
  if (options.reason !== undefined && (reason === undefined || reason === "")) {
    usage("--reason requires non-empty text")
  }
  const targets: Change[] = []
  const seen = new Set<string>()
  for (const selector of selectors) {
    const pr = requiredLivePr(app, selector)
    if (seen.has(pr.id)) usage(`${verb} selectors resolve to change '${pr.id}' more than once`)
    seen.add(pr.id)
    targets.push(pr)
  }
  const spends = targets.map(payloadSpend)
  if (options.burnPayload !== true) refuseUnacknowledgedSpend(verb, spends)
  // Disclosed BEFORE the first event, so a spend that fails partway has still
  // told the operator exactly which revision it was about to burn.
  for (const spend of spends) {
    io.stderr(`yrd: spending payload identity: ${spendLine(spend)} — reopen only with '${spend.reopen}'\n`)
  }
  const withdrawn: Change[] = []
  for (const target of targets) {
    withdrawn.push(await withdrawOne(app, target.id, reason, io))
  }
  await printResult(
    io,
    jsonEnabled(options),
    {
      command,
      ...(reason === undefined ? {} : { reason }),
      spent: spends,
      prs: withdrawn.map(projectChangeTaskStatus),
    },
    createElement(ChangeResultView, { prs: withdrawn, runs: [] }),
  )
}

export type PrunePrsOptions = JsonOption & Readonly<{ dryRun?: boolean }>

type PruneChecks = Readonly<{
  headPresent?: boolean
  ancestorOfBase?: boolean
  mergeTree?: "identical" | "divergent" | "conflicts" | "skipped"
}>

type PruneVerdict = "withdraw" | "would-withdraw" | "keep" | "error"

type PruneRow = Readonly<{
  pr: string
  branch: string
  revision: number
  headSha: string
  base: string
  baseSha?: string
  checks: PruneChecks
  verdict: PruneVerdict
  reason?: string
  error?: string
  detail: string
}>

export type RemergePreflightVerdict = "SUBSUMED-WITHDRAW" | "RECUT" | "RECUT-FORCE" | "FRESH-NOOP"

/** One executed comparison, named the way the operator reading the verdict
 * needs it: which plumbing ran, and what it concluded over which range. */
export type SubsumptionProof = Readonly<{ check: string; detail: string }>

export type RemergePreflightResult = Readonly<{
  command: "pr.recut.preflight"
  pr: string
  revision: number
  verdict: RemergePreflightVerdict
  evidence: Readonly<{
    headSha: string
    proposedHeadSha?: string
    expectedCurrent?: Readonly<{ revision: number; headSha: string; track?: boolean }>
    sourceBaseSha: string
    targetBase: string
    targetBaseSha: string
    pinDistance: Readonly<{ sourceOnly: number; targetOnly: number }>
    patchId: string | null
    patchMatchTarget: string | null
    ancestorOfTarget: boolean
    tree: "identical" | "divergent" | "conflicts" | "skipped"
    /** The comparison that actually EXECUTED and concluded subsumption, absent
     * when none did. `tree: "skipped"` and `patchId: null` are non-measurements
     * sharing their fields with measurements, so this is the only field that
     * says a comparison happened — and a payload burn may be ordered on nothing
     * else (@i/10-yrd/subsumed-verdict-is-vacuous). */
    subsumedBy?: SubsumptionProof
    certified: boolean
    passingCheck: boolean
    requestedQueue: boolean
  }>
  next: string
}>

function pruneLine(row: PruneRow): string {
  const base = row.baseSha === undefined ? row.base : `${row.base}@${short(row.baseSha)}`
  return `[${row.verdict}] ${row.pr} ${row.branch} r${row.revision}: head ${short(row.headSha)} vs ${base} — ${row.detail}`
}

function pruneFailureMessage(pr: string, action: "judged" | "withdrawn", error: unknown): string {
  const cause = error instanceof Error && error.message.trim() !== "" ? error.message : String(error)
  return `change '${pr}' could not be ${action}: ${cause}`
}

function pruneError(pr: Change, baseSha: string | undefined, error: unknown, checks: PruneChecks = {}): PruneRow {
  const message = pruneFailureMessage(pr.id, "judged", error)
  const revision = currentChangeRev(pr)
  return {
    pr: pr.id,
    branch: pr.branch,
    revision: revision.n,
    headSha: revision.head,
    base: pr.base,
    ...(baseSha === undefined ? {} : { baseSha }),
    checks,
    verdict: "error",
    error: message,
    detail: message,
  }
}

function replaceWithPruneError(row: PruneRow, error: unknown): PruneRow {
  const { verdict: _verdict, reason: _reason, error: _error, detail: _detail, ...identity } = row
  const message = pruneFailureMessage(row.pr, "withdrawn", error)
  return { ...identity, verdict: "error", error: message, detail: message }
}

/** A merge moves the base before its Job can record `pr/integrated`. During
 * that side-effect boundary, pruning the exact revision would cancel its own
 * merge and replace the truthful integration with `pr/withdrawn` (22454). */
function mergeRunOwningRevision(app: YrdCliApp, pr: Change): Run | undefined {
  const revision = currentChangeRev(pr)
  return Queues.ids(app.state().queues)
    .map((id) => app.queue.get(id))
    .filter((run): run is Run => run !== undefined)
    .find((run) => {
      const ownsRevision = run.prs.some(
        (candidate) =>
          candidate.id === pr.id && candidate.revision === revision.n && candidate.headSha === revision.head,
      )
      if (!ownsRevision) return false
      const step = run.steps.findLast((candidate) => candidate.kind === "merge")
      if (step?.kind !== "merge" || step.job === undefined) return false
      return step.job.status !== "completed" || step.job.conclusion === "success"
    })
}

function mergeOwnedPruneRow(pr: Change, run: Run): PruneRow {
  const revision = currentChangeRev(pr)
  const reason = `merge run '${run.id}' owns the in-flight merge for revision ${revision.n} (${revision.head})`
  return {
    pr: pr.id,
    branch: pr.branch,
    revision: revision.n,
    headSha: revision.head,
    base: pr.base,
    checks: {},
    verdict: "keep",
    reason,
    detail: `${reason} — kept`,
  }
}

function changedPruneRow(row: PruneRow, pr: Change): PruneRow {
  const revision = currentChangeRev(pr)
  const reason =
    `PR changed during prune from revision ${row.revision} (${row.headSha}) ` +
    `to revision ${revision.n} (${revision.head})`
  return { ...row, verdict: "keep", reason, detail: `${reason} — kept` }
}

async function contentChecks(headSha: string, baseSha: string, git: PruneGitFacts): Promise<PruneChecks> {
  const head = await git.resolveCommit(headSha)
  if (head === undefined) return { headPresent: false }
  const ancestor = await git.isAncestor(headSha, baseSha)
  const mergeTree = ancestor
    ? ("skipped" as const)
    : await (async () => {
        const merged = await git.mergeTree(baseSha, headSha)
        if (merged === undefined) return "conflicts" as const
        return merged === (await git.treeOf(baseSha)) ? ("identical" as const) : ("divergent" as const)
      })()
  return { headPresent: true, ancestorOfBase: ancestor, mergeTree }
}

/** Did this revision author content of its own?
 *
 * Subsumption evidence — head reachable from the base, or a merge that
 * reproduces the base tree — is "this changes nothing relative to the base",
 * and that is equally true of a payload that ALREADY LANDED and of a carrier
 * that never authored one. The two states are opposite and the evidence is
 * identical, so neither check can be read as "already merged" on its own
 * (@i/10-yrd/23184).
 *
 * The tree tuple separates them: a head whose tree equals its OWN recorded
 * base's tree changed nothing, so nothing about it can have landed. Only trees
 * decide — commit and patch counts call a revert-then-restore history "unique
 * work" while the trees are identical (`@yrd/queue` content-identity.ts, the
 * 23167 specimen), and stable patch IDs are attribution evidence only. */
async function authoredContent(
  headSha: string,
  sourceBaseSha: string,
  git: PruneGitFacts,
): Promise<Readonly<{ headTree: string; sourceBaseTree: string; empty: boolean }>> {
  const headTree = await git.treeOf(headSha)
  const sourceBaseTree = await git.treeOf(sourceBaseSha)
  return { headTree, sourceBaseTree, empty: headTree === sourceBaseTree }
}

/** Prove one change's superseded verdict against its resolved base tip. Every
 * check that ran (and every check that was skipped, with why) is named in the
 * returned row so the operator sees exactly what was verified. */
async function pruneVerdict(pr: Change, baseSha: string, git: PruneGitFacts, dryRun: boolean): Promise<PruneRow> {
  const revision = currentChangeRev(pr)
  const identity = {
    pr: pr.id,
    branch: pr.branch,
    revision: revision.n,
    headSha: revision.head,
    base: pr.base,
    baseSha,
  }
  const checks = await contentChecks(revision.head, baseSha, git)
  if (checks.headPresent !== true) {
    return {
      ...identity,
      checks,
      verdict: "keep",
      detail: `head commit is not present in this repository; nothing could be verified — kept`,
    }
  }
  const ancestor = checks.ancestorOfBase === true
  const mergeTree = checks.mergeTree ?? "conflicts"
  const superseded = ancestor || mergeTree === "identical"
  const checked = `ancestor-of-base=${ancestor ? "yes" : "no"}, merge-tree=${mergeTree === "skipped" ? "skipped (head already reachable)" : mergeTree}`
  if (!superseded) {
    return { ...identity, checks, verdict: "keep", detail: `${checked} — live content not on base — kept` }
  }
  // Withdrawal SPENDS the payload and records that its content already merged.
  // Prove there was a payload before spending one: see {@link authoredContent}.
  if (revision.baseSha === undefined) {
    const unproven =
      `revision records no base commit, so its authored payload cannot be proven — ` +
      `superseded and never-authored are indistinguishable here`
    return { ...identity, checks, verdict: "keep", reason: unproven, detail: `${checked} — ${unproven} — kept` }
  }
  const authored = await authoredContent(revision.head, revision.baseSha, git)
  if (authored.empty) {
    const nothing =
      `authored no content: head ${short(revision.head)} and its own base ${short(revision.baseSha)} ` +
      `share tree ${short(authored.headTree)}, so nothing about it landed`
    return { ...identity, checks, verdict: "keep", reason: nothing, detail: `${checked} — ${nothing} — kept` }
  }
  const reason = `superseded: content already in ${baseSha}`
  return {
    ...identity,
    checks,
    verdict: dryRun ? "would-withdraw" : "withdraw",
    reason,
    detail: `${checked} — ${reason}`,
  }
}

export type RemergePreflightOptions = JsonOption &
  Readonly<{
    revision?: number
    queue?: boolean
    proposedHeadSha?: string
    expectedCurrent?: Readonly<{ revision: number; headSha: string; track?: boolean }>
  }>

/** Classify one immutable PR revision against one resolved target without
 * creating refs, appending journal events, or calling the remerger. Exact
 * ancestry/tree equivalence authorizes withdrawal; patch-id is attribution
 * evidence only because stable patch IDs intentionally ignore whitespace. */
/** Classify a change against its live base and print the verdict plus the ONE exact
 * command that follows from it. The result is returned as well as printed, so a
 * mechanical caller (the habitant's self-applied-remedy pass, 22474) runs the
 * same `next` a human would have read off the terminal — one decision function,
 * never a second copy of the verdict rules. */
export async function preflightRemerge(
  app: YrdCliApp,
  selector: string,
  options: RemergePreflightOptions,
  io: YrdCliIO,
): Promise<RemergePreflightResult> {
  if (options.revision !== undefined && (!Number.isInteger(options.revision) || options.revision < 1)) {
    usage("--revision must be a positive integer")
  }
  const pr = requiredLivePr(app, selector)
  const revision = options.revision ?? currentChangeRev(pr).n
  const source = pr.revs.find((candidate) => candidate.n === revision)
  if (source === undefined) {
    raiseFailure("refusal", "revision-missing", `yrd: change '${pr.id}' has no revision ${revision}`)
  }
  if (source.composition !== undefined) {
    raiseFailure(
      "refusal",
      "recut-preflight-composition",
      `yrd: change '${pr.id}' revision ${source.n} has composed source payloads; root-tree preflight cannot prove every source yet`,
    )
  }
  if (source.baseSha === undefined) {
    raiseFailure(
      "configuration",
      "recut-preflight-source-base-missing",
      `yrd: change '${pr.id}' revision ${source.n} has no immutable source base; preflight cannot classify its pin distance`,
    )
  }

  const cwd = io.cwd ?? process.cwd()
  const git = io.pruneGit === undefined ? createPruneGitFacts(cwd) : io.pruneGit(cwd)
  const targetBaseSha = (await git.resolveCommit(`origin/${pr.base}`)) ?? (await git.resolveCommit(pr.base))
  if (targetBaseSha === undefined) {
    raiseFailure(
      "configuration",
      "recut-preflight-target-missing",
      `yrd: change '${pr.id}' targets base '${pr.base}' but neither 'origin/${pr.base}' nor '${pr.base}' resolves to a commit here`,
    )
  }
  const candidateHeadSha = options.proposedHeadSha ?? source.head
  const checks = await contentChecks(candidateHeadSha, targetBaseSha, git)
  if (!checks.headPresent) {
    raiseFailure(
      "configuration",
      "recut-preflight-head-missing",
      `yrd: change '${pr.id}' proposed head '${candidateHeadSha}' is not present in this repository`,
    )
  }
  if (checks.ancestorOfBase === undefined || checks.mergeTree === undefined) {
    throw new Error(`yrd: preflight content proof for '${pr.id}' did not return complete evidence`)
  }
  // `undefined` is not the only shape a non-measurement takes, and the guard
  // above catches only that one. A range whose candidate IS the target base
  // compares a commit against itself: `merge-base --is-ancestor` answers yes for
  // free, `merge-tree` is then skipped on the strength of that free yes, and the
  // verdict reads as three passing proofs over a range where NOTHING was
  // compared. Three real submissions were ordered destroyed on exactly this
  // evidence in one day (PR2191, PR2226, PR2245 —
  // @i/10-yrd/subsumed-verdict-is-vacuous), so the degenerate range is refused
  // before any verdict, not weighed against the checks it makes vacuous.
  if (candidateHeadSha === targetBaseSha) {
    raiseFailure(
      "refusal",
      "recut-preflight-degenerate-range",
      `yrd: change '${pr.id}' revision ${source.n} resolved its candidate head to the target base itself ` +
        `(${short(candidateHeadSha)} == ${short(targetBaseSha)}), so no comparison ran: ancestor=yes is a commit ` +
        `matching itself and merge-tree was skipped on the strength of it. Recorded head is ${short(source.head)}; ` +
        `re-resolve this revision's head before any verdict, and spend no payload on this reading`,
    )
  }
  const pinDistance =
    git.pinDistance ??
    raiseFailure(
      "configuration",
      "recut-preflight-git-facts",
      "yrd: installed PR Git facts do not provide pin-distance evidence",
    )
  const patchMatch =
    git.patchMatch ??
    raiseFailure(
      "configuration",
      "recut-preflight-git-facts",
      "yrd: installed PR Git facts do not provide patch-match evidence",
    )
  const distance = await pinDistance(source.baseSha, targetBaseSha)
  if (distance.sourceOnly !== 0) {
    raiseFailure(
      "refusal",
      "recut-preflight-base-diverged",
      `yrd: change '${pr.id}' revision ${source.n} base ${short(source.baseSha)} diverged from target ${short(targetBaseSha)} ` +
        `(source-only=${distance.sourceOnly}, target-only=${distance.targetOnly})`,
    )
  }
  const patch = await patchMatch(source.baseSha, candidateHeadSha, targetBaseSha)
  // Which comparison EXECUTED and concluded subsumption — not merely which
  // field is non-`undefined`. `"skipped"` shares a union with three real
  // measurements and `patch-id: none` shares a field with a real patch id, so
  // both are matched by name here and neither can arrive as evidence by
  // default. The range is already proven non-degenerate above, which is what
  // makes the reachability answer below a measurement rather than a tautology.
  const subsumedBy: SubsumptionProof | undefined =
    checks.ancestorOfBase === true
      ? {
          check: "git merge-base --is-ancestor",
          detail: `${short(candidateHeadSha)} is reachable from ${short(targetBaseSha)}`,
        }
      : checks.mergeTree === "identical"
        ? {
            check: "git merge-tree",
            detail: `merging ${short(candidateHeadSha)} into ${short(targetBaseSha)} reproduces its tree exactly`,
          }
        : undefined
  const subsumed = subsumedBy !== undefined
  const requiresForce = app.queue.eligibility(pr.id).checks.status === "passed"
  const needsAuthor = changeNeedsAuthor(pr)
  const reauthorizing =
    needsAuthor !== undefined &&
    CONSUMED_QUEUE_AUTHORITY_RESULTS.has(needsAuthor.receipt.code) &&
    source.n === currentChangeRev(pr).n
  if (
    needsAuthor !== undefined &&
    !reauthorizing &&
    options.proposedHeadSha === undefined &&
    source.n === currentChangeRev(pr).n
  ) {
    raiseFailure(
      "refusal",
      "recut-needs-authored-change",
      `yrd: change '${pr.id}' needs author changes after '${needsAuthor.receipt.code}'; ` +
        "an unchanged re-merge cannot resolve it — push new authored content, then retry the printed remedy",
    )
  }
  if (subsumed) {
    // A SUBSUMED-WITHDRAW verdict prints the payload-spend acknowledgement with
    // it, so it must never be reached on evidence a no-op carrier also produces:
    // see {@link authoredContent}.
    const authored = await authoredContent(candidateHeadSha, source.baseSha, git)
    if (authored.empty) {
      raiseFailure(
        "refusal",
        "recut-preflight-empty-payload",
        `yrd: change '${pr.id}' revision ${source.n} authored no content — head ${short(candidateHeadSha)} and its own ` +
          `base ${short(source.baseSha)} share tree ${short(authored.headTree)}, so 'already in ${short(targetBaseSha)}' ` +
          `is unprovable: a payload that never existed and one that landed leave the same evidence here ` +
          `(ancestor-of-base=${checks.ancestorOfBase === true ? "yes" : "no"}, merge-tree=${checks.mergeTree}). ` +
          `Push the payload, or withdraw it with a reason that says nothing shipped`,
      )
    }
  }
  const certifiedCurrentBase =
    options.proposedHeadSha === undefined && distance.targetOnly === 0 && source.recut !== undefined
  const verdict: RemergePreflightVerdict = subsumed
    ? "SUBSUMED-WITHDRAW"
    : reauthorizing
      ? requiresForce
        ? "RECUT-FORCE"
        : "RECUT"
      : certifiedCurrentBase
        ? "FRESH-NOOP"
        : requiresForce
          ? "RECUT-FORCE"
          : "RECUT"
  // The hidden `yrd pr recut` verb is retired (the queue rebuilds by merge on
  // its own): a human's RECUT spelling is resubmitting from the branch tip; the
  // runner applies the same verdict in-process via `applyPreflightVerdict`.
  const next =
    subsumedBy !== undefined
      ? // The subsumed proof IS the payload-spend acknowledgement: content that
        // already merged has nothing left to resubmit. Printed WITH the flag so the
        // command runs as written rather than refusing whoever pastes it — which is
        // exactly why it is keyed on the executed comparison and carries that
        // comparison's name in the reason it records. A burn ordered with no named
        // proof travels onward as a human-relayed instruction that nobody can audit.
        `yrd pr withdraw ${pr.id} --burn-payload ` +
        `--reason "superseded: ${subsumedBy.detail} (proved by ${subsumedBy.check})"`
      : verdict === "RECUT-FORCE" || verdict === "RECUT"
        ? `yrd pr submit ${pr.branch}`
        : options.queue === true
          ? `yrd pr ready ${pr.id}`
          : `yrd pr view ${pr.id}`
  const evidence: RemergePreflightResult["evidence"] = {
    headSha: source.head,
    ...(options.proposedHeadSha === undefined ? {} : { proposedHeadSha: options.proposedHeadSha }),
    ...(options.expectedCurrent === undefined ? {} : { expectedCurrent: options.expectedCurrent }),
    sourceBaseSha: source.baseSha,
    targetBase: pr.base,
    targetBaseSha,
    pinDistance: distance,
    patchId: patch.patchId ?? null,
    patchMatchTarget: patch.targetSha ?? null,
    ancestorOfTarget: checks.ancestorOfBase === true,
    tree: checks.mergeTree,
    ...(subsumedBy === undefined ? {} : { subsumedBy }),
    certified: source.recut !== undefined,
    passingCheck: requiresForce,
    requestedQueue: options.queue === true,
  }
  const result: RemergePreflightResult = {
    command: "pr.recut.preflight",
    pr: pr.id,
    revision: source.n,
    verdict,
    evidence,
    next,
  }
  await printResult(
    io,
    jsonEnabled(options),
    result,
    [
      `${verdict} ${pr.id} r${source.n}`,
      `pin-distance: source-only=${distance.sourceOnly}, target-only=${distance.targetOnly} (${short(source.baseSha)}..${short(targetBaseSha)})`,
      // Not-measured never renders as not-different. `patch-id=none` means the
      // patch was never produced and `merge-tree=skipped` means the merge never
      // ran; printed as bare "none" and "skipped" beside real results, both read
      // as findings, and an operator relayed one onward as an instruction to burn
      // a working payload (@i/10-yrd/subsumed-verdict-is-vacuous).
      patch.patchId === undefined
        ? "patch-id-match-target: NOT MEASURED (no patch-id: the authored diff against the source base is empty)"
        : `patch-id-match-target: ${patch.targetSha === undefined ? "no match" : short(patch.targetSha)} (patch-id=${short(patch.patchId)})`,
      `tree-proof: ancestor=${checks.ancestorOfBase === true ? "yes" : "no"}, merge-tree=${
        checks.mergeTree === "skipped" ? "NOT MEASURED (skipped: head already reachable)" : checks.mergeTree
      }`,
      `subsumed-by: ${subsumedBy === undefined ? "nothing — no comparison concluded subsumption" : `${subsumedBy.check} — ${subsumedBy.detail}`}`,
      `next: ${next}`,
    ].join("\n"),
  )
  return result
}

/** `yrd admin pr prune [--dry-run]` — scan every live change against its base tip and
 * withdraw the ones whose content already merged (head is an ancestor of the
 * base, or merging head into the base reproduces the base tree exactly).
 * Prints one explicit verdict per change; --dry-run emits no events. */
export async function prunePrs(app: YrdCliApp, options: PrunePrsOptions, io: YrdCliIO): Promise<void> {
  const dryRun = options.dryRun === true
  const cwd = io.cwd ?? process.cwd()
  const git = io.pruneGit === undefined ? createPruneGitFacts(cwd) : io.pruneGit(cwd)
  // This comparator deliberately pins the "en" locale so the printed prune verdict
  // order is identical on every host — `compareNatural` (host default locale) would
  // not guarantee that. Cold path: one sort of the live PRs per `yrd admin pr prune`, not
  // the per-tick listing path the collator hoist targets.
  const live = app.bays
    .prs()
    .filter((pr) => isLiveChange(pr))
    .toSorted(
      (left, right) => left.id.localeCompare(right.id, "en", { numeric: true }), // collator-hoist-allow: locale-pinned, cold path
    ) as readonly Change[]

  const rows: PruneRow[] = []
  for (const pr of live) {
    const mergeOwner = mergeRunOwningRevision(app, pr)
    if (mergeOwner !== undefined) {
      rows.push(mergeOwnedPruneRow(pr, mergeOwner))
      continue
    }
    let baseSha: string | undefined
    try {
      baseSha = (await git.resolveCommit(`origin/${pr.base}`)) ?? (await git.resolveCommit(pr.base))
      if (baseSha === undefined) {
        throw new Error(
          `target base '${pr.base}' did not resolve: neither 'origin/${pr.base}' nor '${pr.base}' is a commit here`,
        )
      }
      rows.push(await pruneVerdict(pr, baseSha, git, dryRun))
    } catch (error) {
      rows.push(pruneError(pr, baseSha, error))
    }
  }

  const withdrawn: Change[] = []
  if (!dryRun) {
    for (const [index, row] of rows.entries()) {
      if (row.verdict !== "withdraw") continue
      try {
        await app.refresh()
        const current = app.bays.pr(row.pr)
        if (current !== undefined && isLiveChange(current)) {
          const revision = currentChangeRev(current)
          if (revision.n !== row.revision || revision.head !== row.headSha) {
            rows[index] = changedPruneRow(row, current)
            continue
          }
          const mergeOwner = mergeRunOwningRevision(app, current)
          if (mergeOwner !== undefined) {
            rows[index] = mergeOwnedPruneRow(current, mergeOwner)
            continue
          }
        }
        withdrawn.push(await withdrawOne(app, row.pr, row.reason, io))
      } catch (error) {
        rows[index] = replaceWithPruneError(row, error)
      }
    }
  }

  const kept = rows.filter((row) => row.verdict === "keep").length
  const wouldWithdraw = rows.filter((row) => row.verdict === "would-withdraw").length
  const errors = rows.filter((row) => row.verdict === "error").length
  const summary =
    rows.length === 0
      ? "pr prune: no live PRs to check"
      : `pr prune: checked ${rows.length} live change${rows.length === 1 ? "" : "s"} — ${
          dryRun ? `${wouldWithdraw} would be withdrawn` : `${withdrawn.length} withdrawn`
        }, ${kept} kept${errors === 0 ? "" : `, ${errors} error${errors === 1 ? "" : "s"}`}${
          dryRun ? " (dry run: no events emitted)" : ""
        }`
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.prune",
      dryRun,
      checked: rows.map(({ detail: _detail, ...row }) => row),
      summary: { checked: rows.length, withdrawn: withdrawn.length, wouldWithdraw, kept, errors },
      withdrawn: withdrawn.map(projectChangeTaskStatus),
    },
    [...rows.map(pruneLine), summary].join("\n"),
  )
}

type GitCapture = Readonly<{ code: number; stdout: string }>

/** Real Git plumbing shared by `pr prune` and the re-merge preflight:
 * reachability, exact merge-result tree identity, graph distance, and
 * attribution-only stable patch matching. Only documented exit codes are
 * tolerated; anything else fails loud. */
export function createPruneGitFacts(cwd: string): PruneGitFacts {
  const acceptedResult = (
    args: readonly string[],
    allowedExits: readonly number[],
    result: GitProcessResult,
  ): GitCapture => {
    if (result.timedOut === true) {
      throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
    }
    if (result.code !== 0 && !allowedExits.includes(result.code)) {
      const detail = result.stderr.trim() || result.failure?.trim() || ""
      throw new Error(`yrd: git ${args.join(" ")} failed in '${cwd}'${detail === "" ? "" : `: ${detail}`}`)
    }
    if (result.failure !== undefined && result.code === 0) {
      throw new Error(`yrd: git ${args.join(" ")} failed in '${cwd}': ${result.failure}`)
    }
    return { code: result.code, stdout: result.stdout }
  }
  const localRead = (args: readonly string[]): GitSyncReadCommand => {
    const [verb, ...rest] = args
    switch (verb) {
      case "rev-parse":
      case "merge-base":
      case "rev-list":
      case "cat-file":
      case "diff":
      case "patch-id":
      case "log":
        return { verb, args: rest }
    }
    throw new Error(`yrd: Git command is not a typed local read: ${args.join(" ")}`)
  }
  const reader = adaptProcessGit(undefined, { timeoutMs: GIT_TIMEOUT_MS })
  const git = (args: readonly string[], allowedExits: readonly number[], input?: string): GitCapture =>
    acceptedResult(
      args,
      allowedExits,
      reader.readSync({ repo: cwd, command: localRead(args), ...(input === undefined ? {} : { stdin: input }) }),
    )
  const mutateGit = async (args: readonly string[], allowedExits: readonly number[]): Promise<GitCapture> => {
    await using process = createProcess()
    const result = await adaptProcessGit(process, { timeoutMs: GIT_TIMEOUT_MS }).run({
      repo: cwd,
      args,
    })
    return acceptedResult(args, allowedExits, result)
  }
  return Object.freeze({
    resolveCommit(ref: string): string | undefined {
      const result = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], [1])
      const sha = result.stdout.trim()
      return result.code === 0 && sha !== "" ? sha : undefined
    },
    isAncestor(ancestor: string, descendant: string): boolean {
      return git(["merge-base", "--is-ancestor", ancestor, descendant], [1]).code === 0
    },
    parents(sha: string): readonly string[] {
      const raw = git(["rev-list", "--parents", "-n", "1", sha], []).stdout.trim().toLowerCase()
      const [commit, ...parents] = raw.split(/\s+/u)
      if (commit !== sha.toLowerCase()) {
        throw new Error(
          `yrd: git rev-list --parents of ${short(sha)} returned '${commit ?? "no commit"}', expected the commit itself`,
        )
      }
      return parents
    },
    async mergeTree(baseSha: string, headSha: string): Promise<string | undefined> {
      const args = ["merge-tree", "--write-tree", baseSha, headSha] as const
      // `--quiet` can report success for a real conflict when a sibling
      // directory entry also merges cleanly. Run the normal command and
      // discard stdout so conflict bodies never enter this process.
      const result = await mutateGit(args, [1])
      if (result.code !== 0) return undefined
      const tree = result.stdout.trim().split("\n", 1)[0]?.trim()
      if (tree === undefined || tree === "") {
        throw new Error(`yrd: git merge-tree of ${short(baseSha)} + ${short(headSha)} returned no tree OID`)
      }
      return tree
    },
    treeOf(sha: string): string {
      const tree = git(["rev-parse", `${sha}^{tree}`], []).stdout.trim()
      if (tree === "") throw new Error(`yrd: git rev-parse ${short(sha)}^{tree} returned no tree OID`)
      return tree
    },
    pinDistance(sourceBaseSha: string, targetBaseSha: string) {
      const raw = git(["rev-list", "--left-right", "--count", `${sourceBaseSha}...${targetBaseSha}`], []).stdout.trim()
      const [sourceOnlyRaw, targetOnlyRaw, ...extra] = raw.split(/\s+/u)
      const sourceOnly = Number(sourceOnlyRaw)
      const targetOnly = Number(targetOnlyRaw)
      if (
        extra.length !== 0 ||
        !Number.isSafeInteger(sourceOnly) ||
        sourceOnly < 0 ||
        !Number.isSafeInteger(targetOnly) ||
        targetOnly < 0
      ) {
        throw new Error(
          `yrd: git rev-list distance for ${short(sourceBaseSha)}...${short(targetBaseSha)} was invalid: '${raw}'`,
        )
      }
      return { sourceOnly, targetOnly }
    },
    mergedOnBase(baseSha: string, heads: readonly string[]): readonly string[] {
      const unique = [...new Set(heads)]
      if (unique.length === 0) return []
      // Two batched calls, independent of row count. `cat-file --batch-check`
      // names which commits this repository actually has; `rev-list --no-walk`
      // then lists the ones that are NOT reachable from the base tip. Merged is
      // the difference — never the absence of an object, which would let a
      // shallow or unfetched checkout invent merges.
      const presence = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], [], `${unique.join("\n")}\n`)
      const resolved = new Map<string, string>()
      for (const [index, line] of presence.stdout.trim().split("\n").entries()) {
        const [name, type] = line.trim().split(/\s+/u)
        const requested = unique[index]
        if (requested === undefined || name === undefined || type !== "commit") continue
        resolved.set(name, requested)
      }
      if (resolved.size === 0) return []
      const present = [...resolved.keys()]
      const unmerged = new Set<string>()
      for (let start = 0; start < present.length; start += REV_LIST_BATCH) {
        const batch = present.slice(start, start + REV_LIST_BATCH)
        for (const line of git(["rev-list", "--no-walk", ...batch, "--not", baseSha], []).stdout.split("\n")) {
          const sha = line.trim()
          if (sha !== "") unmerged.add(sha)
        }
      }
      return present.filter((sha) => !unmerged.has(sha)).map((sha) => resolved.get(sha) ?? sha)
    },
    patchMatch(sourceBaseSha: string, headSha: string, targetBaseSha: string) {
      const diff = git(["diff", "--no-ext-diff", "--binary", sourceBaseSha, headSha], []).stdout
      const patchLine = git(["patch-id", "--stable"], [], diff).stdout.trim().split("\n", 1)[0]?.trim()
      const patchId = patchLine?.split(/\s+/u, 1)[0]
      if (patchId === undefined || patchId === "") return {}

      const targetLog = git(
        ["log", "--no-merges", "--format=%H", "--patch", `${sourceBaseSha}..${targetBaseSha}`],
        [],
      ).stdout
      const targetSha = git(["patch-id", "--stable"], [], targetLog)
        .stdout.trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .find(([candidate]) => candidate === patchId)?.[1]
      return { patchId, ...(targetSha === undefined || targetSha === "" ? {} : { targetSha }) }
    },
  })
}
