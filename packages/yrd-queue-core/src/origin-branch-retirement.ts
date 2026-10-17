/** Shared remote custody sequence; callers own ending and archive eligibility. */
import { shellQuote } from "git-super/shell-command"
import type { QueueLocation } from "./events.ts"
import { listRefs } from "./git.ts"

export async function retireOriginBranch(
  store: QueueLocation,
  input: Readonly<{
    branch: string
    head: string
    eventRef: string
    eventTip: string
    archive?: string
    protections?: () => Promise<readonly string[]>
  }>,
): Promise<void> {
  const { branch, head, eventRef, eventTip, archive } = input
  const branchRef = `refs/heads/${branch}`
  const subject = `${branchRef}@${head} at ${store.remote}`
  const publish = store.backend.publish
  if (publish === undefined) throw new Error(`${subject}: Gitomic backend lacks publish for retirement`)
  const protect = async (): Promise<void> => {
    const reasons = await input.protections?.()
    if (reasons !== undefined && reasons.length > 0) throw new Error(`${subject}: kept: ${reasons.join("; ")}`)
  }
  await protect()
  if (archive !== undefined) {
    const previous = (await listRefs(archive, store)).get(archive)
    if (previous !== undefined && previous !== head) {
      throw new Error(`${subject}: archive ${archive} holds ${previous}, not ${head}; it is never overwritten`)
    }
    await publish(
      store.repo,
      [
        { ref: eventRef, expect: eventTip, oid: eventTip },
        { ref: archive, expect: previous ?? "0".repeat(head.length), oid: head },
      ],
      store.remote,
    )
    const observed = (await listRefs(archive, store)).get(archive)
    if (observed !== head) {
      throw new Error(`${subject}: archive ${archive} did not read back as ${head}; found ${observed ?? "absent"}`)
    }
  }
  await protect()
  await publish(
    store.repo,
    [
      { ref: eventRef, expect: eventTip, oid: eventTip },
      ...(archive === undefined ? [] : [{ ref: archive, expect: head, oid: head }]),
      { ref: branchRef, expect: head, oid: null },
    ],
    store.remote,
  )
  const [branches, archives, events] = await Promise.all([
    listRefs(branchRef, store),
    archive === undefined ? Promise.resolve(undefined) : listRefs(archive, store),
    listRefs(eventRef, store),
  ])
  const branchHead = branches.get(branchRef)
  if (branchHead !== undefined) throw new Error(`${subject}: removal did not read back absent; found ${branchHead}`)
  // A server may omit a same-value archive update from its transaction. The
  // lease narrows that race; this readback makes lost custody a loud failure.
  if (archive !== undefined && archives?.get(archive) !== head) {
    throw new Error(
      `${subject}: archive ${archive} no longer holds ${head} after removal; ` +
        `found ${archives?.get(archive) ?? "absent"}; retaining event ${eventRef}@${eventTip} keeps ${head}`,
    )
  }
  if (events.get(eventRef) !== eventTip) {
    throw new Error(
      `${subject}: change moved during retirement; ${eventRef} expected ${eventTip}, found ${events.get(eventRef) ?? "absent"}; ` +
        (archive === undefined ? "caller established published-main custody; " : `archive ${archive} holds ${head}; `) +
        `restore branch ${branch} from that custody: git branch ${shellQuote(branch)} ${head}`,
    )
  }
}
