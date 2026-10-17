/** End an open event change, then retire its remote branch without delaying the ending. */
import { archiveRefFor, ensureArchiveRef } from "git-super/archive-ref"
import { deleteCandidateRefsForShas } from "./candidate-refs.ts"
import { changeInput, changesRef, decide, isOpen, project, queueFormat, queueRef, readEventQueue } from "./events.ts"
import { readEventChain } from "./event-read.ts"
import { createEventStore, gitIn, isAncestor, openEvents, readRemoteCommit, selectionFor, type Git } from "./git.ts"
import { retireOriginBranch } from "./origin-branch-retirement.ts"

export type WithdrawRequest = Readonly<{
  branch: string
  target: Readonly<{ remote: string; branch: string }>
  by: string
  reason?: string
  recipient?: string
  protections?: (head: string, issue?: string) => Promise<readonly string[]>
}>

export type WithdrawnChange = Readonly<{
  branch: string
  head: string
  record: string
  remoteRemoved: boolean
  archive?: string
  recovery?: string
  retirementError?: string
}>
export type Withdrawn = Readonly<{ branch: string; queue: string; withdrawn: readonly WithdrawnChange[] }>
export class NothingToWithdraw extends Error {}

export async function withdraw(git: Git, remote: string, request: WithdrawRequest): Promise<Withdrawn> {
  const root = (await git(["rev-parse", "--show-toplevel"])).trim()
  const queue = request.target.branch
  const store = createEventStore(root, remote, selectionFor(git))
  if ((await queueFormat(store, queue)) !== "event") {
    throw new Error(`${remote}#${queue} uses a legacy Record ref; expected ${queueRef(queue)}`)
  }
  const queueTip = (await readEventQueue(store, queue)).tip
  const ref = changesRef(queue, request.branch)
  const chain = await openEvents({ ...store, ref, writer: request.by })
  const tip = await chain.head()
  if (tip === null) throw new NothingToWithdraw(`${request.branch} on ${queue}: no event change at ${ref}`)
  const history = await readEventChain(chain)
  const state = project(history, ref, root)
  if (!isOpen(state.status)) {
    // Withdrawal ends open work; terminal retirement preserves its existing ending.
    throw new NothingToWithdraw(
      `${request.branch} on ${queue}: already ended ${state.status} at ${state.ending?.id ?? tip}; ` +
        `retire it with: yrd drop ${request.branch} --retire --tip <observed-full-oid> --reason <why>`,
    )
  }
  if (state.status === "merging") {
    throw new Error(`${request.branch} on ${queue}: landing in progress at ${tip}; retry after it settles`)
  }
  const head = state.commit
  if (head === undefined) throw new Error(`${ref}@${tip}: open change has no submitted commit`)
  const branchRef = `refs/heads/${request.branch}`
  const fetchRefs = store.backend.fetchRefs
  if (fetchRefs === undefined) throw new Error("Gitomic backend lacks fetchRefs for withdrawal branch lease")
  const branchHead = (await fetchRefs(root, branchRef, remote)).get(branchRef)
  if (branchHead !== head) {
    throw new Error(
      `${branchRef} at ${remote}: expected submitted head ${head}, found ${branchHead ?? "absent"}; resubmit or let the queue observe its replacement`,
    )
  }
  const input = changeInput("cancelled", {
    queueTip,
    at: new Date(),
    commit: head,
    by: request.by,
    ...(request.recipient === undefined ? {} : { recipient: request.recipient }),
    reason: "withdrawn",
    title: `${request.by} withdrew ${request.branch} from ${queue}`,
    ...(request.reason === undefined ? {} : { content: request.reason }),
  })
  const result = await chain.append(decide(history, input), {
    expect: tip,
    also: [{ ref: branchRef, expect: head, oid: head }],
  })
  const record = result.events.findLast((event) => event.type === "cancelled")?.id
  if (record === undefined) throw new Error(`${ref} in ${root}: withdrawal published no cancelled event`)
  let archive: string | undefined
  let recovery: string | undefined
  let retirementError: string | undefined
  let remoteRemoved = false
  try {
    const protections = request.protections
    const reasons = await protections?.(head, state.issue)
    if (reasons !== undefined && reasons.length > 0) throw new Error(`kept: ${reasons.join("; ")}`)
    const target = await readRemoteCommit(git, remote, `refs/heads/${queue}`)
    if (target === undefined) throw new Error(`published main ${remote}#${queue} is missing`)
    if (!(await isAncestor(git, head, target))) {
      archive = archiveRefFor(request.branch, request.by, new Date().toISOString().slice(0, 10))
      const custody = ensureArchiveRef(root, archive, head)
      if (!custody.ok) throw new Error(custody.reason)
      // The local protected archive also keeps this object after environment closure.
      // Reusing the original name preserves the change and its issue binding on submit.
      recovery = `git branch '${request.branch.replaceAll("'", "'\\''")}' ${head}`
    }
    await retireOriginBranch(store, {
      branch: request.branch,
      head,
      authority: { kind: "event", ref, tip: record },
      archive,
      protections: protections === undefined ? undefined : () => protections(head, state.issue),
    })
    remoteRemoved = true
    await deleteCandidateRefsForShas(gitIn(root, undefined, selectionFor(git)), root, remote, [head])
  } catch (cause) {
    retirementError = `${root} at ${remote}#${queue}, ${branchRef}@${head}: withdrawal completed; retirement incomplete: ${String(cause)}`
  }
  return {
    branch: request.branch,
    queue,
    withdrawn: [{ branch: request.branch, head, record, remoteRemoved, archive, recovery, retirementError }],
  }
}
