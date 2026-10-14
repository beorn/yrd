/** Yrd's one policy for reading Gitomic event chains. */
import type { Process, ProcessResult } from "@yrd/process"
import {
  chainsUnder,
  Conflict,
  gitEnvironment,
  invokeGit,
  listRefs,
  type Event,
  type GitomicBackend,
  type GitSelection,
  type Oid,
  openEvents,
  parseCommit,
  readRawCommits,
  type CommitMeta,
  type ReadRawCommitsOptions,
} from "./git.ts"

/** The wave size a complete read pages at, one git process per wave. */
export const EVENT_READ_LIMIT = 1024

/**
 * A selected change ref moved between this read's advertisement and its fetch.
 * It is the ONE conflict a listing re-inventories instead of reporting (28941):
 * a fresh inventory is its stated cure, and the moved refs ride the error so a
 * caller names them from the field, never by parsing the message.
 */
export class EventRefsMoved extends Conflict {
  constructor(readonly movedRefs: readonly string[]) {
    super(`event refs moved after the selected inventory; retry the reading: ${movedRefs.join(", ")}`, {
      refs: movedRefs,
    })
  }
}

/** How many fresh inventories the multi-prefix reader takes before it gives up (29386). */
const EVENT_REFS_ACQUIRE_ATTEMPTS = 8

/**
 * The selected refs moved inside EVERY advertisement-to-fetch window, so the fresh re-inventory gave
 * up (28941's listing cure, moved down to the one reader both the listing and the run call — 29386).
 * It extends Error, NOT Conflict, on purpose: a Conflict-retrying caller cannot re-run the exhaustion
 * and nest a loop. The attempts and the last moved refs ride the error.
 */
export class EventRefsAcquireExhausted extends Error {
  override readonly name = "EventRefsAcquireExhausted"

  constructor(
    readonly attempts: number,
    readonly refs: readonly string[],
  ) {
    super(
      `event refs moved after the selected inventory ${String(attempts)} times in a row; giving up: ${refs.join(", ")}`,
    )
  }
}

type Chain = Awaited<ReturnType<typeof openEvents>>
type ChainStore = Omit<Parameters<typeof chainsUnder>[1], "limit" | "complete">
export type RecentEventReadOptions = Parameters<typeof readEventCommitMetadata>[2] & { since: number }

/** Eligibility needs scalar metadata only; complete selected chains still belong to Gitomic. */
async function recentEventRefs(
  refs: ReadonlyMap<string, Oid>,
  repo: string,
  options: RecentEventReadOptions,
): Promise<Map<string, Oid>> {
  if (!Number.isFinite(options.since)) {
    throw new TypeError("recent event reading requires a finite recorded-time cutoff")
  }
  type Ending = { kind: string | undefined; time: string | undefined; for: string | undefined }
  const metadata = new Map<Oid, Ending>()
  const unique = (commit: CommitMeta, key: string): string | undefined => {
    const values = commit.trailers.filter(([name]) => name === key)
    return values.length === 1 ? values[0]?.[1] : undefined
  }
  const read = async (ids: readonly Oid[]): Promise<void> => {
    for (let offset = 0; offset < ids.length; offset += 256) {
      const commits = await readEventCommitMetadata(repo, ids.slice(offset, offset + 256), options)
      for (const [id, commit] of commits) {
        metadata.set(id, { kind: unique(commit, "Event"), time: unique(commit, "Time"), for: unique(commit, "For") })
      }
    }
  }
  await read([...new Set(refs.values())])
  const verdicts = new Set<Oid>()
  for (const ending of metadata.values()) {
    if (ending.kind === "notified" && ending.for !== undefined && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(ending.for)) {
      if (!metadata.has(ending.for)) verdicts.add(ending.for)
    }
  }
  await read([...verdicts])
  const selected = new Map<string, Oid>()
  for (const [ref, tip] of refs) {
    const ending = metadata.get(tip)
    if (ending === undefined) throw new Error(`event metadata in ${repo}: advertised tip ${tip} for ${ref} is absent`)
    const current = ending.kind === "notified" && ending.for !== undefined ? metadata.get(ending.for) : ending
    const time = Date.parse(current?.time ?? "")
    // Unknown, state-neutral and nonterminal tips require their complete history.
    if (
      current === undefined ||
      !Number.isFinite(time) ||
      !["merged", "failed", "cancelled"].includes(current.kind ?? "") ||
      time >= options.since
    ) {
      selected.set(ref, tip)
    }
  }
  return selected
}

/** Exact immutable event metadata through the caller's selected Git and captured environment. */
export async function readEventCommitMetadata(
  repo: string,
  ids: readonly Oid[],
  options: Omit<ReadRawCommitsOptions, "run"> & {
    process: Pick<Process, "run">
    selection: GitSelection
    env: NodeJS.ProcessEnv
  },
): Promise<ReadonlyMap<Oid, CommitMeta>> {
  const env = gitEnvironment(options.env)
  const bytes = (result: ProcessResult, stream: "stdout" | "stderr"): Buffer => {
    const output = result.rawOutput?.[stream]
    if (output === undefined || output.head.length + output.tail.length !== output.totalBytes) {
      throw new Error(`event metadata in ${repo}: raw Git ${stream} capture is missing or incomplete`)
    }
    return Buffer.concat([output.head, output.tail])
  }
  const raw = await readRawCommits(repo, ids, {
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs,
    run: async (args, request) => {
      const input = request?.input
      if (input !== undefined && typeof input !== "string") {
        throw new TypeError(`event metadata in ${repo}: raw commit requests require textual Git object ids`)
      }
      const invocation = await invokeGit(
        options.process,
        { args, cwd: repo, selection: options.selection },
        { timeoutMs: request?.timeoutMs },
        env,
        input,
      )
      if (
        invocation.failure !== undefined ||
        invocation.protocol?.refusal !== undefined ||
        invocation.result === undefined
      ) {
        throw new Error(
          `event metadata in ${repo}: selected Git invocation failed: ${invocation.failure ?? invocation.protocol?.refusal?.message ?? "missing result"}`,
        )
      }
      return {
        code: invocation.result.exitCode,
        stdout: bytes(invocation.result, "stdout"),
        stderr: bytes(invocation.result, "stderr"),
      }
    },
  })
  return new Map([...raw].map(([id, buffer]) => [id, parseCommit(id, buffer)]))
}

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
export async function readEventChains(
  prefix: string | readonly string[],
  store: ChainStore,
  recent?: RecentEventReadOptions,
): Promise<ReadonlyMap<string, Event[]>> {
  if (typeof prefix === "string") return chainsUnder(prefix, { ...store, limit: EVENT_READ_LIMIT, complete: true })
  // The multi-prefix reader is the ONE place two inventories can disagree: between this read's
  // advertisement and its fetch an ordinary queue move lands, and mixing the two would return a
  // selection that never existed. A fresh inventory is the stated cure (28941), so the whole
  // advertise/select/fetch/walk re-runs on that typed conflict, bounded; a queue still moving after
  // the bound gives up in a typed exhaustion instead of spinning. The CLI listing and the queue
  // run's listChangeHistories both call this one reader, so the policy lives here once (29386).
  for (let attempt = 1; ; attempt++) {
    try {
      return await readMultiPrefixInventory(prefix, store, recent)
    } catch (error) {
      if (!(error instanceof EventRefsMoved)) throw error
      if (attempt >= EVENT_REFS_ACQUIRE_ATTEMPTS) throw new EventRefsAcquireExhausted(attempt, error.movedRefs)
    }
  }
}

/** One fresh inventory for a multi-prefix read; its advertise, select, fetch and walk never reuse a refusal. */
async function readMultiPrefixInventory(
  prefix: readonly string[],
  store: ChainStore,
  recent?: RecentEventReadOptions,
): Promise<ReadonlyMap<string, Event[]>> {
  // One advertisement is the selection boundary. Listing hot and cold separately can miss a chain that
  // atomically moves between them. Fetch only selected event refs, never all advertised branch objects.
  const backend = store.backend
  if (backend?.listRefs === undefined) throw new TypeError("multi-prefix event reading requires a ref-capable backend")
  const exact = prefix.every((part) => !part.endsWith("/"))
  // A detail read already names both possible refs: one named fetch supplies their coherent inventory
  // and objects without advertising every other branch. A listing selects its two prefixes first.
  let acquiredExact = false
  let advertised: ReadonlyMap<string, Oid>
  if (exact && store.remote !== undefined) {
    const fetch = backend.fetchRefs
    if (fetch === undefined) throw new TypeError("remote event reading requires a fetch-capable backend")
    advertised = await fetch(store.repo, prefix, store.remote, { absent: "omit" })
    acquiredExact = true
  } else advertised = await listRefs("refs/", store)
  let selected = new Map(
    [...advertised].filter(([ref]) =>
      prefix.some((part) => ref === part || (part.endsWith("/") && ref.startsWith(part))),
    ),
  )
  if (selected.size === 0) return new Map()
  if (recent !== undefined && !exact) {
    if (store.remote !== undefined && !acquiredExact) {
      if (backend.fetchRefs === undefined) throw new TypeError("remote event reading requires a fetch-capable backend")
      const acquired = await backend.fetchRefs(store.repo, [...selected.keys()], store.remote, { absent: "omit" })
      const moved = [...selected].filter(([ref, oid]) => acquired.get(ref) !== oid).map(([ref]) => ref)
      if (moved.length > 0) throw new EventRefsMoved(moved)
      acquiredExact = true
    }
    selected = await recentEventRefs(selected, store.repo, recent)
    if (selected.size === 0) return new Map()
  }
  const captured: GitomicBackend = {
    ...backend,
    listRefs: (_repo, requested) =>
      Promise.resolve(
        new Map(
          [...selected].filter(([ref]) =>
            typeof requested === "string" ? ref.startsWith(requested) : requested.includes(ref),
          ),
        ),
      ),
    fetchRefs: async (repo, _refs, remote) => {
      if (acquiredExact) return selected
      if (backend.fetchRefs === undefined) throw new TypeError("remote event reading requires a fetch-capable backend")
      const acquired = await backend.fetchRefs(repo, [...selected.keys()], remote, { absent: "omit" })
      const moved = [...selected].filter(([ref, oid]) => acquired.get(ref) !== oid).map(([ref]) => ref)
      if (moved.length > 0) throw new EventRefsMoved(moved)
      return selected
    },
  }
  // Gitomic still owns the one complete, batched event walk and immutable-tip decoding.
  if (recent !== undefined && !exact) {
    const names = [...selected.keys()]
    const complete = new Map<string, Event[]>()
    for (let offset = 0; offset < names.length; offset += 64) {
      const cohort = await chainsUnder("refs/", {
        ...store,
        remote: undefined,
        backend: captured,
        refs: names.slice(offset, offset + 64),
        limit: EVENT_READ_LIMIT,
        complete: true,
      })
      for (const [ref, events] of cohort) complete.set(ref, events)
    }
    return complete
  }
  return chainsUnder("refs/", { ...store, backend: captured, limit: EVENT_READ_LIMIT, complete: true })
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
