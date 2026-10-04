/** Yrd's one policy for reading Gitomic event chains. */
import { chainsUnder, type Event, type Oid, openEvents } from "./git.ts"

/** The wave size a complete read pages at, one git process per wave. */
export const EVENT_READ_LIMIT = 1024

type Chain = Awaited<ReturnType<typeof openEvents>>
type ChainStore = Omit<Parameters<typeof chainsUnder>[1], "limit" | "complete">

/** Read a complete chain from one fixed tip, including events older than one page. */
export async function readEventChain(chain: Chain, acquiredTip?: Oid): Promise<Event[]> {
  const tip = acquiredTip ?? (await chain.head())
  if (tip === null) return []
  const events = await chain.events({ at: tip, limit: EVENT_READ_LIMIT, complete: true })
  if (events.length === 0 || events.at(-1)?.id !== tip) {
    throw new Error(`event chain at ${tip}: tip was not readable`)
  }
  return events
}

/** Every chain under a prefix, each read to its root in the one shared complete walk. */
export async function readEventChains(prefix: string, store: ChainStore): Promise<ReadonlyMap<string, Event[]>> {
  return chainsUnder(prefix, { ...store, limit: EVENT_READ_LIMIT, complete: true })
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
