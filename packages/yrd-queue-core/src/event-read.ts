/** Yrd's one policy for reading Gitomic event chains. */
import { chainsUnder, type Event, type Oid, openEvents } from "./git.ts"

export const EVENT_READ_LIMIT = 1024

type Chain = Awaited<ReturnType<typeof openEvents>>
type ChainStore = Omit<Parameters<typeof chainsUnder>[1], "limit">

/** Assemble chronological pages until the first event proves genesis was reached. */
async function completeChain(chain: Chain, recent: readonly Event[], label: string): Promise<Event[]> {
  let history = [...recent]
  const seen = new Set<string>()
  while (history[0]?.parent !== null && history.length > 0) {
    const cursor = history[0]?.parent
    if (cursor === undefined || seen.has(cursor)) throw new Error(`${label}: event paging did not advance at ${cursor}`)
    seen.add(cursor)
    const older = await chain.events({ at: cursor, limit: EVENT_READ_LIMIT })
    if (older.length === 0 || older.at(-1)?.id !== cursor) {
      throw new Error(`${label}: event paging could not read parent ${cursor}`)
    }
    history = [...older, ...history]
  }
  return history
}

/** Read a complete chain from one fixed tip, including events older than one page. */
export async function readEventChain(chain: Chain, acquiredTip?: Oid): Promise<Event[]> {
  const tip = acquiredTip ?? (await chain.head())
  if (tip === null) return []
  const recent = await chain.events({ at: tip, limit: EVENT_READ_LIMIT })
  if (recent.length === 0 || recent.at(-1)?.id !== tip) {
    throw new Error(`event chain at ${tip}: tip was not readable`)
  }
  return completeChain(chain, recent, `event chain at ${tip}`)
}

/** Keep Gitomic's batched first page, then page only chains that need history. */
export async function readEventChains(prefix: string, store: ChainStore): Promise<ReadonlyMap<string, Event[]>> {
  const recent = await chainsUnder(prefix, { ...store, limit: EVENT_READ_LIMIT })
  const complete = new Map<string, Event[]>()
  for (const [ref, page] of recent) {
    complete.set(ref, await completeChain(await openEvents({ ...store, ref }), page, `${ref} in ${store.repo}`))
  }
  return complete
}

/** Resolve a receipt from its exact commit, independent of the chain's length. */
export async function readEventAt(chain: Chain, id: string, ref: string, repo: string): Promise<Event> {
  let events: Event[]
  try {
    events = await chain.events({ at: id, limit: 1 })
  } catch (error) {
    throw new Error(`${ref} in ${repo}: cannot read event ${id}; check event identity and repository access`, {
      cause: error,
    })
  }
  const event = events[0]
  if (events.length !== 1 || event?.id !== id) {
    throw new Error(`${ref} in ${repo}: event ${id} was not found at its exact identity`)
  }
  return event
}
