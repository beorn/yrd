import { changeDeliveryState, changeRevisionLineage, isTracked, type Change, type ChangeRev } from "@yrd/bay"
import { raiseFailure } from "@yrd/core"
import { adaptProcessGit, gitFailure, type Process } from "@yrd/process"
import { unobservableBranchRemedy, type UnobservableBranchReason } from "./remedy-admissibility.ts"
import { observeLiveBranch, requireObservedBranchHead, type LiveBranchObservation } from "./remote-branch.ts"
import type { YrdCliIO, YrdCliServices } from "./types.ts"

const GIT_TIMEOUT_MS = 30_000
const MAX_COMMIT_ROWS = 20

type RemergeBranchFreshnessOptions = Readonly<{
  queue?: boolean
}>

function runGit(process: Pick<Process, "run">, cwd: string, args: readonly string[]) {
  return adaptProcessGit(process, { timeoutMs: GIT_TIMEOUT_MS }).run({ repo: cwd, args })
}

function requireObservedBranch(
  observed: LiveBranchObservation,
  pr: Change,
  remedy: (reason: UnobservableBranchReason) => string,
  injected: boolean,
): string {
  // One ladder, shared with `pr view` and the re-merge preflight
  // (`requireObservedBranchHead`): the phase→kind split lives there, so these
  // three surfaces can attach different remedies but cannot disagree about
  // which phase is a settled fact and which is weather. The `absent` case cites
  // this class of bug: the queue reads the kind to decide between retrying and
  // evicting (@yrd/core/deleted-branch-head-wedges-queue).
  return requireObservedBranchHead(observed, {
    observer: () => ({
      code: "recut-branch-observer-missing",
      message: `yrd: cannot refresh live branch '${pr.branch}' before re-merging change '${pr.id}'; ${observed.ok ? "" : observed.detail}`,
    }),
    absent: () => ({
      code: "recut-branch-absent",
      message:
        `yrd: change '${pr.id}' cannot be re-merged: its source branch '${pr.branch}' is gone from origin ` +
        `(${observed.ok ? "" : observed.detail})\n${remedy("absent")}`,
    }),
    fetch: () => ({
      code: "recut-branch-refresh-failed",
      message: `yrd: could not refresh live branch '${pr.branch}' from origin: ${observed.ok ? "" : observed.detail}\n${remedy("unreachable")}`,
    }),
    resolve: () => ({
      code: "recut-branch-head-missing",
      message: injected
        ? `yrd: cannot verify change '${pr.id}' because ${observed.ok ? "" : observed.detail}`
        : `yrd: refreshed live branch '${pr.branch}' but '${observed.target}' did not resolve to a commit: ${observed.ok ? "" : observed.detail}`,
    }),
  })
}

async function liveBranchHead(
  pr: Change,
  recorded: ChangeRev,
  options: RemergeBranchFreshnessOptions,
  services: Pick<YrdCliServices, "process">,
  io: YrdCliIO,
): Promise<string> {
  const cwd = io.cwd ?? globalThis.process.cwd()
  const queueFlag = options.queue === true ? " --queue" : ""
  const delivery = changeDeliveryState(pr)
  const remedy = (reason: UnobservableBranchReason): string =>
    unobservableBranchRemedy(reason, pr, delivery, recorded, queueFlag).text
  const git = io.pruneGit?.(cwd)
  const observed = await observeLiveBranch(services.process, cwd, pr.branch, git?.resolveCommit)
  return requireObservedBranch(observed, pr, remedy, git !== undefined)
}

async function commitRangeEvidence(
  services: Pick<YrdCliServices, "process">,
  io: YrdCliIO,
  recordedHead: string,
  liveHead: string,
): Promise<string> {
  const command = `git log --oneline ${recordedHead}..${liveHead}`
  const process = services.process
  if (process === undefined || io.pruneGit !== undefined) {
    return `commits between: supplied observer did not enumerate the range\ninspect: ${command}`
  }
  const cwd = io.cwd ?? globalThis.process.cwd()
  const distance = await runGit(process, cwd, ["rev-list", "--left-right", "--count", `${recordedHead}...${liveHead}`])
  if (distance.timedOut === true || distance.code !== 0) {
    return `commits between: unavailable (${gitFailure(distance, GIT_TIMEOUT_MS)})\ninspect: ${command}`
  }
  const counts = /^(\d+)\s+(\d+)$/u.exec(distance.stdout.trim())
  if (counts === null) {
    return `commits between: unavailable (invalid symmetric distance '${distance.stdout.trim()}')\ninspect: ${command}`
  }
  const recordedOnly = Number(counts[1])
  const liveOnly = Number(counts[2])
  if (recordedOnly > 0 && liveOnly > 0) {
    return (
      `commits divergent: recorded-only=${String(recordedOnly)}, live-only=${String(liveOnly)}\n` +
      `inspect: git log --oneline --left-right ${recordedHead}...${liveHead}`
    )
  }
  if (recordedOnly > 0) {
    return (
      `commits between: live branch is behind the recorded revision by ${String(recordedOnly)} commit(s)\n` +
      `inspect: git log --oneline ${liveHead}..${recordedHead}`
    )
  }
  const result = await runGit(process, cwd, [
    "log",
    "--reverse",
    `--max-count=${String(MAX_COMMIT_ROWS)}`,
    "--format=%H %s",
    `${recordedHead}..${liveHead}`,
    "--",
  ])
  if (result.timedOut === true || result.code !== 0) {
    return `commits between: unavailable (${gitFailure(result, GIT_TIMEOUT_MS)})\ninspect: ${command}`
  }
  const rows = result.stdout.trim()
  return rows === ""
    ? `commits between: none reported by the refreshed observer\ninspect: ${command}`
    : `commits between:\n${rows
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}\ninspect: ${command}`
}

/** Either the re-merge may proceed on its recorded source, or the change opted into
 * tracking and its branch moved, so the caller must re-record the live head
 * before continuing. Every other drift already refused inside the check. */
export type RemergeBranchFreshness =
  | Readonly<{ status: "fresh" }>
  | Readonly<{ status: "tracked-drift"; recorded: ChangeRev; liveHead: string }>

/** Queue work is reproducible: it operates on a recorded immutable source.
 * If the authored branch moved, implicit selection is ambiguous and must stop
 * before journal writes or Queue admission.
 *
 * A TRACKED PR (`yrd pr submit --track`) answered that ambiguity up front: the
 * live head is the intended source. It returns `tracked-drift` so the caller
 * records the new revision — the same operation an operator performs by hand —
 * and continues. Reproducibility is untouched: each run still executes a
 * frozen recorded revision. */
export async function requireImplicitRemergeBranchFreshness(
  pr: Change,
  selected: ChangeRev,
  options: RemergeBranchFreshnessOptions,
  services: Pick<YrdCliServices, "process">,
  io: YrdCliIO,
): Promise<RemergeBranchFreshness> {
  const recorded = changeRevisionLineage(pr, selected.n)[0]
  if (recorded === undefined) {
    throw new Error(`yrd: change '${pr.id}' revision ${selected.n} has no recorded source lineage`)
  }
  const liveHead = await liveBranchHead(pr, recorded, options, services, io)
  if (liveHead === recorded.head) return { status: "fresh" }
  if (isTracked(pr)) return { status: "tracked-drift", recorded, liveHead }

  const recordVerb = changeDeliveryState(pr) === "pushed" ? "create" : "submit"
  raiseFailure(
    "refusal",
    "recut-branch-moved",
    `yrd: change '${pr.id}' recorded revision ${recorded.n} head '${recorded.head}', but live branch ` +
      `'${pr.branch}' is '${liveHead}'. This change is explicitly untracked, so the queue will not silently ` +
      `act on stale work.\n` +
      `${await commitRangeEvidence(services, io, recorded.head, liveHead)}\n` +
      `To adopt tracking (the default), so moved heads are recorded as revisions:\n` +
      `  yrd pr edit ${pr.id} --track\n` +
      `To record the live head once while staying untracked:\n  yrd pr ${recordVerb} ${pr.branch}`,
  )
}
