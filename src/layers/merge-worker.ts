import type {
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  ChangeId,
  Effect,
  EffectHandler,
  Layer,
  TransitionResult,
} from "../types.ts"
import { makeEvent } from "../core.ts"
import { createGitConfigSource, resolveOption } from "../config.ts"
import { queuedChangesets, queueTarget, stateChangeEvent } from "./queue.ts"

/**
 * withMergeWorker — the serial merge driver (M1-a of @hab/20926-gitbay: "drain
 * the queue serially by invoking the merge command per target; journal every
 * transition; resume-on-restart via replay"). It builds ON withQueue: it reads
 * the queue's published state (queuedChangesets/queueTarget) and drives the
 * merging transitions the queue folds. Per the interlock rule it never reaches
 * into the queue's internals — only its state and the shared event builder.
 *
 * Resume-on-restart falls out of the journal-first core (core.ts dispatch
 * journals events BEFORE running effects): the queued→merging event is durable
 * before `merge.run` ever spawns, so a crash mid-merge leaves the changeset in
 * `merging` in the replayed state — nothing is lost or double-counted. drain()
 * deliberately picks ONLY `queued` changesets (never a stray `merging` one) so a
 * crash can't cause a double-merge on the next drain; the stuck changeset is
 * resumed by an explicit `requeue` (merging→queued) once the operator/host has
 * confirmed the interrupted merge left nothing half-applied. Journal-first +
 * drain-only-queued is why the "Nothing to integrate" false-success class after
 * a killed submit is structurally impossible.
 */

const EV_QUEUE_EMPTY = "queue.empty"
const FX_MERGE_RUN = "merge.run"
const LAYER = "merge-worker"

export type MergeWorkerOptions = {
  /** Inline override; else `BAY_MERGE_COMMAND`, else `git config bay.mergeCommand`.
   *  No default — a missing merge command is a loud error naming the config key.
   *  Run via `sh -c` with `{target}` and `{changeset}` substituted. */
  mergeCommand?: string
  /** cwd for ambient (gitconfig) resolution of `bay.mergeCommand`. Defaults to
   *  process.cwd(). Not consulted at all when `mergeCommand` is inline. */
  configCwd?: string
}

// ---------- drain reducer (pure) ----------

function reduceDrain(bay: BayRuntime, state: BayState): TransitionResult {
  const queued = queuedChangesets(state)
  if (queued.length === 0) {
    // Observable no-op: this event lets a drain loop see "nothing to do" from the
    // dispatch return value without polling state. No layer folds it (it changes
    // nothing) — it exists purely as a progress marker in the journal + return.
    return { state, events: [makeEvent(bay, EV_QUEUE_EMPTY)], effects: [] }
  }
  const oldest = queued[0]!
  const target = queueTarget(state, oldest.id)
  // queued → merging (validated); the effect carries exactly what the command needs.
  const event = stateChangeEvent(bay, oldest.id, "queued", "merging")
  const effect: Effect = { type: FX_MERGE_RUN, data: { changeset: oldest.id, target } }
  return { state, events: [event], effects: [effect] }
}

// ---------- merge.run effect handler (async; the only I/O) ----------

/** Resolve the merge command: inline > BAY_MERGE_COMMAND > git config
 *  bay.mergeCommand > (no default → throw). Resolved lazily per run; when
 *  `mergeCommand` is inline, resolveOption short-circuits and no git spawns. */
async function resolveMergeCommand(opts: MergeWorkerOptions): Promise<string> {
  const source = createGitConfigSource(opts.configCwd ?? process.cwd())
  const resolved = await resolveOption(opts.mergeCommand, "mergeCommand", source)
  if (resolved === undefined || resolved.trim() === "") {
    throw new Error(
      "bay: merge command not configured — set it inline " +
        "(withMergeWorker({ mergeCommand })), via BAY_MERGE_COMMAND, or " +
        "`git config bay.mergeCommand`. Refusing to merge with no command.",
    )
  }
  return resolved
}

/** Last `max` chars of captured output, trailing whitespace trimmed — enough to
 *  teach in a journal `detail` without embedding megabytes of merge log. */
function tail(text: string, max = 2000): string {
  const trimmed = text.replace(/\s+$/, "")
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}

function makeMergeRunHandler(opts: MergeWorkerOptions): EffectHandler {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as { changeset: ChangeId; target: string }

    // Read the changeset's CURRENT state as the transition source. drain just set
    // it to `merging`; reading it (vs hardcoding) means a broken caller trips
    // assertTransition instead of silently mis-recording the outcome.
    const cs = (await bay.state()).changesets[d.changeset]
    if (!cs) throw new Error(`bay: merge.run: no changeset '${d.changeset}' in state`)
    const from = cs.state

    const mergeCommand = await resolveMergeCommand(opts)
    const cmd = mergeCommand.replaceAll("{target}", d.target).replaceAll("{changeset}", d.changeset)

    // sh -c so the operator's own quoting works; never split on spaces. A spawn
    // failure (no `sh`) throws — that is a broken host, not a merge verdict.
    const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (code === 0) {
      return [stateChangeEvent(bay, d.changeset, from, "merged", tail(stdout))]
    }
    // A non-zero merge command is a DOMAIN outcome (rejected), never a crash — do
    // not throw. The detail names the exit code and the stderr tail (law 7).
    const errTail = tail(stderr)
    const detail = errTail === "" ? `exit ${code}` : `exit ${code}: ${errTail}`
    return [stateChangeEvent(bay, d.changeset, from, "rejected", detail)]
  }
}

// ---------- the plugin ----------

export function withMergeWorker(opts: MergeWorkerOptions = {}): BayPlugin {
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      // No apply: the merge worker emits changeset.state-changed events that the
      // queue layer folds; it owns no state slice of its own.
      reduce(state, command, next) {
        if (command.type === "drain") return reduceDrain(bay, state)
        return next(state, command)
      },
      effects: {
        [FX_MERGE_RUN]: makeMergeRunHandler(opts),
      },
    }
    return bay.use(layer)
  }
}
