/** End an open event change while leaving its branch available for a later submit. */
import { deleteCandidateRefsForShas } from "./candidate-refs.ts"
import { changeInput, changesRef, decide, isOpen, project, queueFormat, queueRef, readEventQueue } from "./events.ts"
import { readEventChain } from "./event-read.ts"
import { createEventStore, gitIn, openEvents, selectionFor, type Git } from "./git.ts"

export type WithdrawRequest = Readonly<{
  branch: string
  target: Readonly<{ remote: string; branch: string }>
  by: string
  reason?: string
}>

export type WithdrawnChange = Readonly<{ branch: string; head: string; record: string }>
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
    throw new NothingToWithdraw(
      `${request.branch} on ${queue}: already ended ${state.status} at ${state.ending?.id ?? tip}`,
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
  await deleteCandidateRefsForShas(gitIn(root, undefined, selectionFor(git)), root, remote, [head])
  return { branch: request.branch, queue, withdrawn: [{ branch: request.branch, head, record }] }
}
