/**
 * ONE derivation of "the changes" — the population every `change`/`pr` verb
 * searches, across both admission lanes.
 *
 * The defect this closes (@i/10-yrd, found 2026-08-30): `yrd pr view PR2706`
 * answered `no change 'PR2706' — searched 2155 change(s)` while the queue was
 * running PR2706's checks and had already merged PR2651 and PR2702–PR2705.
 * `pr list` topped out at PR2599. Every one of those verbs read
 * `BaysState.prs` — the change-RECORD store — and post-S6 that store is no
 * longer the population. A `refs/for/<base>/<change>` push writes a
 * `branch/submitted` fact and mints NO record on purpose (the record mint is
 * retired: `bay.submit` refuses `record-mint-retired` on this lane), so the
 * newest ~55 changes existed only as derived members and the record store's
 * count was arithmetic over the wrong set. It is the same failure the queue
 * dashboard had (`dashboard-submit-fact-visibility.test.ts`) and the same fix:
 * read both lanes through one expression.
 *
 * NOT a second reader over a second record. The identity home is the one the
 * S6 door already designated — {@link resolveMemberById}: a record when one
 * exists (the frozen store is complete for its own era), else the newest
 * retained `ChangeSnapshot` naming that id, which is "the only home a
 * post-door derived member's identity has". This module widens that seam from
 * `ResolvedMember` to a full {@link Change} by handing the snapshot to
 * {@link derivedChange} — the SAME shaper admission uses — so a reader and the
 * queue cannot disagree about whether a change is open.
 *
 * What is deliberately NOT here: a submit fact with no retained run yet. That
 * change has no identity to address — its id is minted at admission
 * (commit-before-escape), so before the first compose there is no `PRnnn` for
 * a selector to name and inventing one would be the second record this exists
 * to avoid. Those submissions are the queue dashboard's rows
 * (`humanQueueProjection`, keyed by branch); {@link pendingSubmitBranches}
 * counts them so a not-found sentence can say they exist rather than let the
 * reader conclude the push never landed.
 */
import {
  hasChangeRecord,
  resolveChange,
  parseChangeSelector,
  changeNotFoundMessage,
  type BaysState,
  type Change,
} from "@yrd/bay"
import type { DeepReadonly } from "@yrd/core"
import { derivedChange } from "./derived-admission.ts"
import { Queues, type ChangeSnapshot, type QueueRecord, type QueuesState } from "./model.ts"

/**
 * The newest retained snapshot for each RECORDLESS id, plus the run that
 * carried it — one walk over the retained runs, because every caller here
 * needs the same map and walking per-id turned `pr list` into an O(ids × runs)
 * scan.
 *
 * "Newest" is the same rule {@link latestChangeSnapshot} applies: runs in
 * natural id order, the last one seen winning, so a re-run at a newer revision
 * supersedes the snapshot an earlier run left.
 */
function derivedSnapshots(
  bays: DeepReadonly<BaysState>,
  queues: DeepReadonly<QueuesState>,
): Map<string, Readonly<{ snapshot: ChangeSnapshot; record: DeepReadonly<QueueRecord> }>> {
  const latest = new Map<string, Readonly<{ snapshot: ChangeSnapshot; record: DeepReadonly<QueueRecord> }>>()
  for (const record of Queues.values(queues as QueuesState) as readonly DeepReadonly<QueueRecord>[]) {
    for (const snapshot of record.prs) {
      // Intent members are pin-advance materializations, not changes; a
      // snapshot whose id HAS a record belongs to the record lane and is
      // already in the population from the store side.
      if (snapshot.intent !== undefined) continue
      if (hasChangeRecord(bays, snapshot.id)) continue
      latest.set(snapshot.id, { snapshot: snapshot as ChangeSnapshot, record })
    }
  }
  return latest
}

/**
 * A retained snapshot read back as the change it identifies.
 *
 * `submittedAt` prefers the live submit fact when one still stands for exactly
 * this head — that is the submission's own clock, and it is what the dashboard
 * shows. A merged change's fact is swept, so the run that admitted it supplies
 * the fallback rather than leaving the field absent: an absent `submittedAt`
 * renders as an unsubmitted draft, which is the opposite of what a merged
 * change is.
 */
function changeOfSnapshot(
  bays: DeepReadonly<BaysState>,
  queues: DeepReadonly<QueuesState>,
  entry: Readonly<{ snapshot: ChangeSnapshot; record: DeepReadonly<QueueRecord> }>,
): Change {
  const { snapshot, record } = entry
  const submit = bays.submits[snapshot.branch]
  const submittedAt = submit !== undefined && submit.sha === snapshot.headSha ? submit.at : record.startedAt
  return derivedChange(queues, {
    id: snapshot.id,
    branch: snapshot.branch,
    base: snapshot.base,
    revision: snapshot.revision,
    headSha: snapshot.headSha,
    submittedAt,
    ...(snapshot.changeId === undefined ? {} : { changeId: snapshot.changeId }),
    ...(snapshot.props === undefined ? {} : { props: snapshot.props }),
    ...(snapshot.issue === undefined ? {} : { issue: snapshot.issue }),
    ...(snapshot.name === undefined ? {} : { title: snapshot.name }),
    ...(snapshot.composition === undefined ? {} : { composition: snapshot.composition }),
  })
}

/**
 * Every change a selector can name, both lanes, records first then derived
 * members in natural id order.
 *
 * Record rows are the store's own values, untouched: cutting readers onto this
 * function must not change a single answer the record lane already gives, or
 * the fix would be a rewrite of 2155 changes' history rather than a widening.
 */
export function queueChanges(bays: DeepReadonly<BaysState>, queues: DeepReadonly<QueuesState>): Change[] {
  const records = Object.values(bays.prs) as Change[]
  const derived = [...derivedSnapshots(bays, queues).values()].map((entry) => changeOfSnapshot(bays, queues, entry))
  return [...records, ...derived]
}

/**
 * How many changes a lookup over {@link queueChanges} searched.
 *
 * This is the denominator `changeNotFoundMessage` prints, and printing the
 * record store's count instead is exactly how the defect hid: `searched 2155`
 * was true of the store and false of the question, so three seats read a live
 * change's absence as their own typo. Counted, never estimated — the walk is
 * the same one the lookup does.
 */
export function queueChangeCount(bays: DeepReadonly<BaysState>, queues: DeepReadonly<QueuesState>): number {
  return Object.keys(bays.prs).length + derivedSnapshots(bays, queues).size
}

/**
 * Branches holding a live submit fact that no retained run has admitted yet —
 * real submissions with no id, so no selector reaches them.
 *
 * A record's own standing fact is excluded: the record IS that branch's
 * submission (one lane consumes one push), so counting it would double-count
 * the change the store already lists.
 */
export function pendingSubmitBranches(bays: DeepReadonly<BaysState>, queues: DeepReadonly<QueuesState>): string[] {
  const admitted = new Set<string>()
  for (const record of Queues.values(queues as QueuesState) as readonly DeepReadonly<QueueRecord>[]) {
    for (const snapshot of record.prs) {
      if (snapshot.intent === undefined) admitted.add(snapshot.branch)
    }
  }
  const recorded = new Set(Object.values(bays.prs).map((pr) => pr.branch))
  return Object.keys(bays.submits).filter((branch) => !admitted.has(branch) && !recorded.has(branch))
}

/**
 * Every branch some change already names — the carried set the stranded-ref
 * sweep judges refs against.
 *
 * BOTH lanes plus the door: a record (any state — a withdrawn change is work
 * someone already decided about), a derived member (a post-door change living
 * only as a retained snapshot), or a standing submit fact awaiting its first
 * admission. The record store alone is the lane the sweep used to read, and
 * that lane flagged LIVE branches: a derived change's branch — or a
 * submission sitting at the door — read as uncarried, so the one rail built
 * to find lost work reported work the queue was actively holding
 * (@i/10-yrd C3b).
 */
export function carriedBranches(bays: DeepReadonly<BaysState>, queues: DeepReadonly<QueuesState>): Set<string> {
  const carried = new Set(queueChanges(bays, queues).map((change) => change.branch))
  for (const branch of pendingSubmitBranches(bays, queues)) carried.add(branch)
  return carried
}

/**
 * Resolve a selector against BOTH lanes — the one entry point every `change`
 * verb calls instead of indexing `bays.prs`.
 *
 * Store first, by the store's own resolver (ids, revision selectors, branch,
 * name and bay aliases all keep working exactly as before). Only when the
 * store has no answer does the derived lane run, and it cannot collide: post-
 * door ids are minted strictly above the frozen store's max, so an id has a
 * record or snapshots, never both.
 *
 * A derived change answers to its id (`PR2706`, `pr#2706`, `2706.1`) and to
 * its branch, because the branch is what the operator pushed and the id is
 * something the queue minted after the fact.
 */
export function resolveQueueChange(
  bays: DeepReadonly<BaysState>,
  queues: DeepReadonly<QueuesState>,
  selector: string,
): Change | undefined {
  const record = resolveChange(bays as BaysState, selector)
  if (record !== undefined) return record
  const id = parseChangeSelector(selector)?.pr ?? selector
  const snapshots = derivedSnapshots(bays, queues)
  const byId = snapshots.get(id)
  if (byId !== undefined) return changeOfSnapshot(bays, queues, byId)
  const byBranch = [...snapshots.values()].findLast((entry) => entry.snapshot.branch === selector)
  return byBranch === undefined ? undefined : changeOfSnapshot(bays, queues, byBranch)
}

/**
 * The not-found sentence with a denominator that answers the question actually
 * asked: how many changes were searched, across both lanes.
 *
 * Every emitter that has the queue state in scope calls this rather than
 * {@link changeNotFoundMessage} directly — that one keeps the record-store
 * count, which is the truth only for a caller that searched the record store
 * alone (yrd-bay's own record-lane mutation guard, which cannot see queues and
 * genuinely cannot act on a derived change).
 *
 * A pending count rides along when standing submit facts have no id yet, so
 * "your push is here, it has not been admitted" stops reading as "your push
 * never arrived" — the reading that makes an operator push again.
 */
export function queueChangeNotFoundMessage(
  bays: DeepReadonly<BaysState>,
  queues: DeepReadonly<QueuesState>,
  selector: string,
): string {
  const base = changeNotFoundMessage(bays as BaysState, selector, queueChangeCount(bays, queues))
  const pending = pendingSubmitBranches(bays, queues).length
  return pending === 0
    ? base
    : `${base}; ${String(pending)} submitted branch(es) await admission and have no id yet — 'yrd queue list' shows them by branch`
}
