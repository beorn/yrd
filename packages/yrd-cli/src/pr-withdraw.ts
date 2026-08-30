import { adaptProcessGit, createProcess, type GitSyncReadCommand } from "@yrd/process"
import type { GitProcessResult } from "git-super/process"
import { createElement } from "react"
import {
  currentChangeRev,
  hasChangeRecord,
  isLiveChange,
  changeDeliveryState,
  changeNeedsAuthor,
  type BaysState,
  type Change,
  type ProjectedBranchSubmit,
} from "@yrd/bay"
import { raiseFailure, type DeepReadonly } from "@yrd/core"
import {
  buildMergedTruthIndex,
  derivedLaneBranches,
  queueChangeNotFoundMessage,
  resolveQueueChange,
  landedSubmitBranches,
  landedSubmits,
  Queues,
  type LandedSubmitScan,
  type MergedTruthGit,
  type Run,
} from "@yrd/queue"
import { usage } from "./invocation.ts"
import { printResult } from "./output.tsx"
import { ChangeResultView } from "./queue-status-view.tsx"
import { projectChangeTaskStatus } from "./task-status.ts"
import { observeLiveBranch, requireObservedBranchHead } from "./remote-branch.ts"
import type { PruneGitFacts, YrdCliApp, YrdCliIO, YrdCliServices } from "./types.ts"

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
  const state = app.state()
  // Both lanes. A derived-lane change resolves here so `pr withdraw PR2706`
  // reaches its own refusal (a submission withdrawn by removing the submit
  // ref) instead of the not-found sentence, which read as "you mistyped it".
  const pr = resolveQueueChange(state.bays, state.queues, selector)
  if (pr === undefined) {
    raiseFailure("refusal", "pr-missing", queueChangeNotFoundMessage(state.bays, state.queues, selector))
  }
  const delivery = changeDeliveryState(pr)
  if (!isLiveChange(pr)) {
    raiseFailure(
      "refusal",
      "pr-terminal",
      `yrd: change '${pr.id}' is ${delivery}; a terminal change cannot be withdrawn`,
    )
  }
  // Withdrawal spends a RECORD's payload identity. A derived-lane change has
  // no record to spend — its submission IS the git ref — so name the one cure
  // rather than let the record-lane guard refuse it with a sentence about a
  // change that "does not exist" when the queue is running it.
  if (!hasChangeRecord(state.bays, pr.id)) {
    raiseFailure(
      "refusal",
      "pr-derived-lane",
      `yrd: change '${pr.id}' is a derived-lane submission on branch '${pr.branch}'; it has no record to withdraw — ` +
        `retire the standing fact instead: ${retireFactCommand(pr.branch)}`,
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

type PruneVerdict = "withdraw" | "would-withdraw" | "keep" | "stale-fact" | "error"

/** Which population a row was scanned from. `record` rows are live changes in
 * the record store; `derived` rows are live submit facts the derived lane owns
 * — recordless BY DESIGN, so `app.bays.prs()` structurally cannot contain one
 * and a scan of the store alone answers about the wrong population
 * (@i/10-yrd/24002-prune-blind-to-derived). */
type PruneLane = "record" | "derived"

type PruneRow = Readonly<{
  lane: PruneLane
  /** The record-lane change id. Absent on a derived row: a derived member's
   * identity is minted at ADMISSION, so a standing fact no run has admitted
   * has no id yet and its branch is the only name it has. */
  pr?: string
  branch: string
  /** Absent on a derived row, for the same reason `pr` is. */
  revision?: number
  headSha: string
  base: string
  baseSha?: string
  checks: PruneChecks
  verdict: PruneVerdict
  reason?: string
  error?: string
  detail: string
}>

/** A row the RECORD lane produced. Every record-lane row carries the change id
 * and revision the withdrawal path needs, and typing that here is what keeps
 * the withdrawal loop closed to derived rows without a runtime filter. */
type RecordPruneRow = PruneRow & Readonly<{ pr: string; revision: number }>

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
  const name = row.pr === undefined ? `derived ${row.branch}` : `${row.pr} ${row.branch} r${String(row.revision)}`
  return `[${row.verdict}] ${name}: head ${short(row.headSha)} vs ${base} — ${row.detail}`
}

function pruneFailureMessage(pr: string, action: "judged" | "withdrawn", error: unknown): string {
  const cause = error instanceof Error && error.message.trim() !== "" ? error.message : String(error)
  return `change '${pr}' could not be ${action}: ${cause}`
}

function pruneError(pr: Change, baseSha: string | undefined, error: unknown, checks: PruneChecks = {}): RecordPruneRow {
  const message = pruneFailureMessage(pr.id, "judged", error)
  const revision = currentChangeRev(pr)
  return {
    lane: "record",
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

function replaceWithPruneError(row: RecordPruneRow, error: unknown): RecordPruneRow {
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

function mergeOwnedPruneRow(pr: Change, run: Run): RecordPruneRow {
  const revision = currentChangeRev(pr)
  const reason = `merge run '${run.id}' owns the in-flight merge for revision ${revision.n} (${revision.head})`
  return {
    lane: "record",
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

function changedPruneRow(row: RecordPruneRow, pr: Change): RecordPruneRow {
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
async function pruneVerdict(pr: Change, baseSha: string, git: PruneGitFacts, dryRun: boolean): Promise<RecordPruneRow> {
  const revision = currentChangeRev(pr)
  const identity = {
    lane: "record" as const,
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
  /** The Git process the branch observation needs to ask ORIGIN whether the
   * source branch still exists. Optional because `io.pruneGit` answers instead
   * wherever the caller injects deterministic facts; when neither is present
   * the observation refuses rather than assuming the branch is there. */
  services?: Pick<YrdCliServices, "process">,
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
  // THE SOURCE MUST BE THERE BEFORE ANY VERDICT IS COMPUTED — for every change,
  // not only the tracked-drift one.
  //
  // A caller in tracked-drift passes `proposedHeadSha`, which the tracked loop
  // already resolved through `observeLiveBranch` and already refuses absence on.
  // EVERY OTHER CHANGE fell through to the recorded `source.head` and this
  // oracle never asked about the branch at all — so a change whose branch was
  // gone from the receiver still got a full verdict, computed from a sha that
  // was merely present as an object. Measured 2026-08-29 on PR2599: the oracle
  // proved reachability for a commit that was neither the branch's live head
  // nor the frozen revision it proposed to burn, and ordered `--burn-payload`
  // on 330 unlanded lines; it was caught by hand. `headPresent` below does not
  // cover this and never could — it asks whether a SHA is an object here, and
  // the sha was. The question nobody asked is whether the BRANCH still exists.
  //
  // Observed through the same ladder `pr view` and the re-merge path use, so
  // the three cannot disagree about what absence means. Any unobservable phase
  // stops the verdict: this verb's next act is destruction, and there is no
  // reading of "I could not see the source" that justifies proceeding to one.
  // Called for the REFUSAL, not for the head it returns — see below.
  requireObservedBranchHead(await observeLiveBranch(services?.process, cwd, pr.branch, git.resolveCommit), {
    observer: () => ({
      code: "recut-preflight-branch-observer-missing",
      message: `yrd: cannot observe live branch '${pr.branch}' before classifying change '${pr.id}'`,
    }),
    absent: () => ({
      code: "recut-preflight-branch-absent",
      message:
        `yrd: change '${pr.id}' cannot be classified: its source branch '${pr.branch}' is gone from origin, ` +
        `so no verdict about revision ${source.n} can be proved and no payload may be spent on one\n` +
        retireFactCommand(pr.branch),
    }),
    fetch: () => ({
      code: "recut-preflight-branch-refresh-failed",
      message:
        `yrd: could not refresh live branch '${pr.branch}' from origin while classifying change '${pr.id}'\n` +
        `retry: yrd pr remerge ${pr.id} --preflight`,
    }),
    resolve: () => ({
      code: "recut-preflight-branch-absent",
      message:
        `yrd: change '${pr.id}' names source branch '${pr.branch}', which resolves to no commit here — ` +
        `neither 'origin/${pr.branch}' nor '${pr.branch}'. Revision ${source.n}'s recorded head ` +
        `${short(source.head)} may still be a readable object, and that proves nothing about the branch: ` +
        `no verdict is computed and no payload is spent on a source that is not there\n` +
        `inspect: git rev-parse --verify origin/${pr.branch}^{commit}`,
    }),
  })
  // The observed head is deliberately DISCARDED. The subject of this
  // classification is unchanged: a SUBSUMED-WITHDRAW spends revision
  // `source.n`'s payload identity, which lives at `source.head`, so the proof
  // must still be about that commit — the observation above is a precondition,
  // never a substitute for it. Swapping the live head in here is exactly the
  // confusion that made PR2599's "proof" answer a question about the
  // revision's own base while reading as three passing checks.
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
    // SUBJECT CHECK, and it comes first: a SUBSUMED-WITHDRAW spends revision
    // `source.n`'s payload identity, which lives at `source.head`. So the
    // subsumption must be proved ABOUT that commit. When a caller proposes a
    // different head — the tracked-drift path passes the LIVE branch head
    // (`proposedHeadSha: freshness.liveHead`) — the proof answers a question
    // about the proposed content and says NOTHING about the frozen payload the
    // withdraw would destroy.
    //
    // Measured 2026-08-29 on PR2599: the oracle proved `e2016c4dfe92 is
    // reachable from fb2d5a94167c` and ordered `--burn-payload` on frozen
    // revision 5 at `46126a051c`, which is not an ancestor of main and carried
    // 330 unlanded lines. Both statements were true at once, because rev 5 is
    // built ON TOP of the commit proved reachable — so the "proof" was a fact
    // about the revision's own BASE. Of the three evidence lines the two that
    // read strongest were tautologies (pin-distance was main against main;
    // tree-proof was about the base), and `patch-id: no match` — the only
    // content-level signal — was the only one telling the truth.
    //
    // Drift itself is not an error: the verdict falls through to RECUT, whose
    // remedy is resubmitting from the branch tip. What is refused is spending a
    // payload on a proof about a different commit.
    if (candidateHeadSha !== source.head) {
      raiseFailure(
        "refusal",
        "recut-preflight-proof-subject-mismatch",
        `yrd: change '${pr.id}' revision ${source.n} proved subsumption about ${short(candidateHeadSha)}, but a ` +
          `withdraw spends this revision's payload at ${short(source.head)} — different commits, so the proof says ` +
          `nothing about what would be destroyed. Re-prove it against ${short(source.head)}, or resubmit from the ` +
          `branch tip; spend no payload on this reading`,
      )
    }
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
        `--reason "superseded: ${subsumedBy.detail} (proved by ${subsumedBy.check}; ` +
        `spends revision ${source.n} payload at ${short(source.head)})"`
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

/** The one cure for a stale standing fact, worded exactly as the compose words
 * it when it refuses to derive an admission for already-landed content — so an
 * operator reads ONE command wherever the same ghost surfaces. */
function retireFactCommand(branch: string): string {
  return `git push bay :refs/yrd/submit/${branch}`
}

/**
 * Judge one DERIVED member — a live submit fact on a branch the derived lane
 * owns — with the same content proof the record lane gets. Prune's tree
 * equality is the STRONGER oracle here: the compose's own
 * `isSubmitContentLanded` is ancestry-only and misses a rebased landing, which
 * `git merge-tree` catches.
 *
 * Prune never withdraws one, and that is a structural fact rather than a
 * conservatism: withdrawal spends a RECORD's payload identity, a derived member
 * has no record to spend, and the fact itself lives in a git ref the journal
 * does not own — closing anything here would report success against a store the
 * queue never reads. The honest disposition is `stale-fact` plus the cure.
 *
 * No `authoredContent` proof runs, and it is not missing by oversight: a
 * `ProjectedBranchSubmit` records no source base commit, so the
 * already-landed / never-authored ambiguity that guard resolves cannot be
 * resolved here. It also does not need to be. That guard exists to stop a
 * payload BURN on ambiguous evidence; nothing is burnt on this path, and both
 * readings of the ambiguity share one disposition — an empty carrier's
 * standing fact is as stale as a merged one's, and retirement is the cure for
 * either.
 */
async function derivedVerdict(
  branch: string,
  submit: DeepReadonly<ProjectedBranchSubmit>,
  baseSha: string,
  git: PruneGitFacts,
): Promise<PruneRow> {
  const identity = { lane: "derived" as const, branch, headSha: submit.sha, base: submit.base, baseSha }
  const checks = await contentChecks(submit.sha, baseSha, git)
  if (checks.headPresent !== true) {
    return {
      ...identity,
      checks,
      verdict: "keep",
      detail: "head commit is not present in this repository; nothing could be verified — kept",
    }
  }
  const ancestor = checks.ancestorOfBase === true
  const mergeTree = checks.mergeTree ?? "conflicts"
  const checked = `ancestor-of-base=${ancestor ? "yes" : "no"}, merge-tree=${mergeTree === "skipped" ? "skipped (head already reachable)" : mergeTree}`
  if (!(ancestor || mergeTree === "identical")) {
    return { ...identity, checks, verdict: "keep", detail: `${checked} — live content not on base — kept` }
  }
  const reason =
    `superseded: content already in ${baseSha} — a standing fact with no record, so prune cannot withdraw it; ` +
    `retire the fact instead (${retireFactCommand(branch)})`
  return { ...identity, checks, verdict: "stale-fact", reason, detail: `${checked} — ${reason}` }
}

/** A derived member's judgement failed. Named for what it is — prune judged a
 * branch, not a change — so the row can never be read as a change id. */
function derivedError(
  branch: string,
  submit: DeepReadonly<ProjectedBranchSubmit>,
  baseSha: string | undefined,
  error: unknown,
): PruneRow {
  const cause = error instanceof Error && error.message.trim() !== "" ? error.message : String(error)
  const message = `derived member on '${branch}' could not be judged: ${cause}`
  return {
    lane: "derived",
    branch,
    headSha: submit.sha,
    base: submit.base,
    ...(baseSha === undefined ? {} : { baseSha }),
    checks: {},
    verdict: "error",
    error: message,
    detail: message,
  }
}

export type PruneExcludedSubmit = Readonly<{ branch: string; sha: string; reason: string; next?: string }>

/**
 * Standing submit facts NEITHER pass reached, with why — so a clean count can
 * never imply prune looked at every fact in the estate.
 *
 * Every branch in `bays.submits` belongs to exactly one lane: the record pass
 * covers it when a LIVE record owns it, the derived pass when
 * {@link derivedLaneBranches} offers it. Two cells fall through both — a fact
 * standing at a terminal record's landing commit (the PR2139 signature) and a
 * terminal record's same-sha fact — and both are stale refs whose cure is
 * retirement, not a run.
 */
function unscannedSubmits(
  bays: DeepReadonly<BaysState>,
  scanned: ReadonlySet<string>,
  scan: LandedSubmitScan,
): PruneExcludedSubmit[] {
  // Landed content is the REPOSITORY's answer, not the record store's: the
  // store could only see a fact whose sha equalled some terminal record's
  // integration commit, which misses every recordless branch and every
  // merge-time rebuild.
  const landed = new Map(scan.landed.map((row) => [row.branch, row.mergeCommit]))
  const open = new Map(scan.unresolved.map((row) => [row.branch, row]))
  return Object.entries(bays.submits)
    .filter(([branch]) => !scanned.has(branch))
    .map(([branch, submit]) => {
      const terminal = Object.values(bays.prs).findLast((pr) => pr.branch === branch && !isLiveChange(pr as Change))
      if (landed.has(branch)) {
        const mergeCommit = landed.get(branch)
        return {
          branch,
          sha: submit.sha,
          reason:
            `content is already on '${submit.base}'` +
            (mergeCommit === undefined ? "" : ` (merged by ${short(mergeCommit)})`) +
            " — a stale re-projection of merged work",
          next: retireFactCommand(branch),
        }
      }
      const unresolved = open.get(branch)
      if (unresolved !== undefined) {
        return {
          branch,
          sha: submit.sha,
          reason: `the repository could not say whether this content landed (${unresolved.reason}): ${unresolved.detail}`,
          ...(unresolved.reason === "degenerate" ? { next: retireFactCommand(branch) } : {}),
        }
      }
      if (terminal !== undefined) {
        return {
          branch,
          sha: submit.sha,
          reason: `terminal change ${terminal.id} already accounts for this head`,
          next: retireFactCommand(branch),
        }
      }
      // Unreachable by the lane partition above; reported rather than dropped,
      // because a fact no lane claims is exactly the state a count must not
      // silently absorb.
      return { branch, sha: submit.sha, reason: "no lane claims this fact" }
    })
    .toSorted((left, right) => left.branch.localeCompare(right.branch))
}

/** `yrd admin pr prune [--dry-run]` — scan BOTH queue populations against their
 * base tip and withdraw the record-lane changes whose content already merged
 * (head is an ancestor of the base, or merging head into the base reproduces
 * the base tree exactly). Prints one explicit verdict per member; --dry-run
 * emits no events.
 *
 * The two populations are scanned and REPORTED separately, and the facts
 * neither lane reached are named. Iterating `app.bays.prs()` alone was the
 * 2026-08-28 defect: derived members are recordless by definition, so the
 * record store structurally cannot hold one, and prune reported "2 changes
 * checked, nothing to prune" over an estate holding four derived ghosts
 * (@i/10-yrd/24002-prune-blind-to-derived). A count is only ever printed
 * beside the name and size of the population it was counted over. */
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

  const bays = app.state().bays
  // Which standing facts has the repository ALREADY delivered? Asked of git,
  // through the same reader the compose's door uses, so prune and admission
  // cannot disagree about landed content either.
  const landedScan = await landedSubmits(
    io.mergedTruthGit === undefined ? createMergedTruthGit(cwd) : io.mergedTruthGit(cwd),
    async (base) => {
      const tip = (await git.resolveCommit(`origin/${base}`)) ?? (await git.resolveCommit(base))
      if (tip === undefined) {
        throw new Error(
          `target base '${base}' did not resolve: neither 'origin/${base}' nor '${base}' is a commit here`,
        )
      }
      return buildMergedTruthIndex(
        io.mergedTruthGit === undefined ? createMergedTruthGit(cwd) : io.mergedTruthGit(cwd),
        cwd,
        { tip },
      )
    },
    bays,
  )
  // The DERIVED population, enumerated by the same function the compose selects
  // from, so prune and admission never disagree about who is in the lane.
  const derivedBranches = derivedLaneBranches(bays, landedSubmitBranches(landedScan))
  const excluded = unscannedSubmits(bays, new Set([...live.map((pr) => pr.branch), ...derivedBranches]), landedScan)

  const rows: RecordPruneRow[] = []
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

  const derivedRows: PruneRow[] = []
  for (const branch of derivedBranches) {
    const submit = bays.submits[branch]
    if (submit === undefined) continue
    let baseSha: string | undefined
    try {
      baseSha = (await git.resolveCommit(`origin/${submit.base}`)) ?? (await git.resolveCommit(submit.base))
      if (baseSha === undefined) {
        throw new Error(
          `target base '${submit.base}' did not resolve: neither 'origin/${submit.base}' nor '${submit.base}' is a commit here`,
        )
      }
      derivedRows.push(await derivedVerdict(branch, submit, baseSha, git))
    } catch (error) {
      derivedRows.push(derivedError(branch, submit, baseSha, error))
    }
  }

  // Only record-lane rows can reach a withdrawal: `withdrawOne` closes a Change
  // and cancels the Queue work holding its authority, and a derived member has
  // neither. The loop stays over `rows` so that is structural, not a filter
  // somebody can drop.
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

  const checked = [...rows, ...derivedRows]
  const kept = checked.filter((row) => row.verdict === "keep").length
  const wouldWithdraw = checked.filter((row) => row.verdict === "would-withdraw").length
  const staleFacts = checked.filter((row) => row.verdict === "stale-fact").length
  const errors = checked.filter((row) => row.verdict === "error").length
  // Both populations are named with their sizes even when one is empty: the
  // sentence a reader acts on must say what was scanned, never just how much.
  const scanned =
    `scanned ${rows.length} live change${rows.length === 1 ? "" : "s"} (record lane) and ` +
    `${derivedRows.length} derived member${derivedRows.length === 1 ? "" : "s"} (derived lane)`
  const disposition =
    checked.length === 0
      ? "nothing to check"
      : `${dryRun ? `${wouldWithdraw} would be withdrawn` : `${withdrawn.length} withdrawn`}, ${kept} kept${
          staleFacts === 0 ? "" : `, ${staleFacts} stale fact${staleFacts === 1 ? "" : "s"} to retire`
        }${errors === 0 ? "" : `, ${errors} error${errors === 1 ? "" : "s"}`}${
          dryRun ? " (dry run: no events emitted)" : ""
        }`
  const summary = [`pr prune: ${scanned} — ${disposition}`]
  // A store-vs-repository disagreement is a FINDING of the store cutover, and
  // it is printed per fact, never counted away. The repository's answer is the
  // one prune acted on.
  for (const conflict of landedScan.disagreements) {
    summary.push(
      `pr prune: RECORD/REPOSITORY DISAGREEMENT on ${conflict.branch} @ ${short(conflict.sha)} — ` +
        `the change record says ${conflict.store}` +
        (conflict.record === undefined ? "" : ` (via ${conflict.record})`) +
        `, the repository says ${conflict.derived}: ${conflict.detail}`,
    )
  }
  if (excluded.length > 0) {
    summary.push(
      `pr prune: ${excluded.length} standing submit fact${excluded.length === 1 ? "" : "s"} neither lane scanned — ` +
        excluded.map((row) => `${row.branch} (${row.reason})`).join("; "),
    )
  }
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.prune",
      dryRun,
      // The populations, in the machine-readable result too, so a mechanical
      // reader cannot mistake a clean count for a complete one either.
      scanned: { record: rows.length, derived: derivedRows.length, standingFacts: landedScan.facts },
      landed: landedScan.landed,
      landingUnresolved: landedScan.unresolved,
      landingDisagreements: landedScan.disagreements,
      excluded,
      checked: checked.map(({ detail: _detail, ...row }) => row),
      summary: {
        checked: checked.length,
        record: rows.length,
        derived: derivedRows.length,
        withdrawn: withdrawn.length,
        wouldWithdraw,
        kept,
        staleFacts,
        errors,
        excluded: excluded.length,
        landed: landedScan.landed.length,
        landingUnresolved: landedScan.unresolved.length,
        landingDisagreements: landedScan.disagreements.length,
      },
      withdrawn: withdrawn.map(projectChangeTaskStatus),
    },
    [...checked.map(pruneLine), ...summary].join("\n"),
  )
}

/**
 * The merged-truth reader's two git reads, for `pr prune`'s cwd.
 *
 * `text` throws on any non-zero exit — an unreadable repository is a loud
 * failure, never an empty index, and it is that throw which makes a NEGATIVE
 * containment answer trustworthy. `optionalText` maps a non-zero exit to
 * undefined for the one question where that is a real answer (`merge-base
 * --is-ancestor` exits 1 for "not contained"). A timeout is fatal in both,
 * inside `adaptProcessGit`: git never finished asking, and reporting that as
 * "not contained" would read a stalled repository as a clean not-merged.
 *
 * `repo` is honoured rather than ignored: merged-truth passes it explicitly,
 * and silently substituting the cwd would answer a different repository's
 * question without saying so.
 */
export function createMergedTruthGit(cwd: string): MergedTruthGit {
  const reader = adaptProcessGit(undefined, { timeoutMs: GIT_TIMEOUT_MS })
  const localRead = (args: readonly string[]): GitSyncReadCommand => {
    const [verb, ...rest] = args
    switch (verb) {
      case "rev-parse":
      case "merge-base":
      case "log":
        return { verb, args: rest }
    }
    throw new Error(`yrd: merged-truth asked for a command that is not a typed local read: ${args.join(" ")}`)
  }
  const run = (repo: string, args: readonly string[]): GitProcessResult => {
    const result = reader.readSync({ repo: repo === "" ? cwd : repo, command: localRead(args) })
    if (result.timedOut === true) {
      throw new Error(`yrd: git ${args.join(" ")} timed out after ${String(GIT_TIMEOUT_MS)}ms`)
    }
    return result
  }
  return {
    text(repo, args) {
      const result = run(repo, args)
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.failure?.trim() || ""
        throw new Error(`yrd: git ${args.join(" ")} failed in '${repo}'${detail === "" ? "" : `: ${detail}`}`)
      }
      return Promise.resolve(result.stdout.trim())
    },
    optionalText(repo, args) {
      const result = run(repo, args)
      return Promise.resolve(result.code === 0 ? result.stdout.trim() : undefined)
    },
  }
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
