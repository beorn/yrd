/** Yrd's one policy for reading Gitomic event chains. */
import { parseCommit, readRawCommits, type CommitMeta, type ReadRawCommitsOptions } from "gitomic"
import type { Process, ProcessResult } from "@yrd/process"
import {
  chainsUnder,
  Conflict,
  invokeGit,
  listRefs,
  type Event,
  type GitomicBackend,
  type GitSelection,
  type Oid,
  openEvents,
} from "./git.ts"

/** The wave size a complete read pages at, one git process per wave. */
export const EVENT_READ_LIMIT = 1024

type Chain = Awaited<ReturnType<typeof openEvents>>
type ChainStore = Omit<Parameters<typeof chainsUnder>[1], "limit" | "complete">

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
        options.env,
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
): Promise<ReadonlyMap<string, Event[]>> {
  if (typeof prefix === "string") return chainsUnder(prefix, { ...store, limit: EVENT_READ_LIMIT, complete: true })
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
  const selected = new Map(
    [...advertised].filter(([ref]) =>
      prefix.some((part) => ref === part || (part.endsWith("/") && ref.startsWith(part))),
    ),
  )
  if (selected.size === 0) return new Map()
  const captured: GitomicBackend = {
    ...backend,
    listRefs: () => Promise.resolve(selected),
    fetchRefs: async (repo, _refs, remote) => {
      if (acquiredExact) return selected
      if (backend.fetchRefs === undefined) throw new TypeError("remote event reading requires a fetch-capable backend")
      const acquired = await backend.fetchRefs(repo, [...selected.keys()], remote, { absent: "omit" })
      const moved = [...selected].filter(([ref, oid]) => acquired.get(ref) !== oid).map(([ref]) => ref)
      if (moved.length > 0) {
        throw new Conflict(`event refs moved after the selected inventory; retry the reading: ${moved.join(", ")}`, {
          refs: moved,
        })
      }
      return selected
    },
  }
  // Gitomic still owns the one complete, batched event walk and immutable-tip decoding.
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
