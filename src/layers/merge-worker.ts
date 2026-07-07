import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  Effect,
  EffectHandler,
  Layer,
  PrId,
  TransitionResult,
} from "../types.ts"
import { makeEvent } from "../core.ts"
import { createGitConfigSource, resolveOption } from "../config.ts"
import { git, resolveBaseRef } from "./git.ts"
import { queuedPrs, queueTarget, stateChangeEvent } from "./queue.ts"

/**
 * withMergeWorker — the serial merge driver (v0.1-a of @hab/20926-gitbay: "drain
 * the queue serially by invoking the merge command per target; journal every
 * transition; resume-on-restart via replay"). It builds ON withQueue: it reads
 * the queue's published state (queuedPrs/queueTarget) and drives the
 * merging transitions the queue folds. Per the interlock rule it never reaches
 * into the queue's internals — only its state and the shared event builder.
 *
 * Resume-on-restart falls out of the journal-first core (core.ts dispatch
 * journals events BEFORE running effects): the queued→merging event is durable
 * before `merge.run` ever spawns, so a crash mid-merge leaves the PR in
 * `merging` in the replayed state — nothing is lost or double-counted. drain()
 * deliberately picks ONLY `queued` PRs (never a stray `merging` one) so a
 * crash can't cause a double-merge on the next drain; the stuck PR is
 * resumed by an explicit `retry` (merging→queued) once the operator/host has
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
   *  Run via `sh -c` with `{target}` and `{pr}` substituted (`{changeset}` still
   *  substitutes too, so existing configs keep working). */
  mergeCommand?: string
  /** cwd for ambient (gitconfig) resolution of `bay.mergeCommand`. Defaults to
   *  process.cwd(). Not consulted at all when `mergeCommand` is inline. */
  configCwd?: string
  /** The mainline repo for the post-merge ancestry verify (the lying-merge
   *  guard, epic AC4 / fable24 G1.1): when set, a merge command's exit 0 is
   *  NOT trusted — the target must actually be an ancestor of the refreshed
   *  mainline (origin/main if it exists, else HEAD) or the changeset is
   *  journaled `rejected` with a teaching detail. Catches both a lying merge
   *  command and the merged-locally-but-push-failed class (the verify reads
   *  origin/main, so an unpushed landing is not a landing). Unset = legacy
   *  trust-exit-0 (library callers with non-git merge commands); the CLI host
   *  ALWAYS sets it.
   *
   *  Also the merge command's spawn cwd: `mergeCommand` runs with this as its
   *  working directory (falling back to process.cwd() when unset), so a
   *  `{target}`-landing command doesn't need to hardcode `cd <path> &&`. */
  mainRepo?: string
}

// ---------- drain reducer (pure) ----------

/** No arg: land the OLDEST queued PR (one step). With args.pr: land exactly
 *  that PR — refusing with a teaching message when it is not queued, because
 *  landing something in another state either needs `retry` first (rejected/
 *  merging) or is meaningless (merged). */
function reduceDrain(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const rawPr = command.args?.pr
  if (rawPr !== undefined && (typeof rawPr !== "string" || rawPr.trim() === "")) {
    throw new Error("bay: land: 'pr' must be a non-empty string when provided")
  }

  let next
  if (typeof rawPr === "string") {
    const pr = state.prs[rawPr]
    if (!pr) throw new Error(`bay: land: no PR '${rawPr}' — git bay ls lists them`)
    if (pr.state === "merged") throw new Error(`bay: land: ${rawPr} is already merged — nothing to land`)
    if (pr.state !== "queued") {
      throw new Error(
        `bay: land: ${rawPr} is ${pr.state} — put it back in the queue first: git bay retry ${rawPr}`,
      )
    }
    next = pr
  } else {
    const queued = queuedPrs(state)
    if (queued.length === 0) {
      // Observable no-op: this event lets a land loop see "nothing to do" from the
      // dispatch return value without polling state. No layer folds it (it changes
      // nothing) — it exists purely as a progress marker in the journal + return.
      return { state, events: [makeEvent(bay, EV_QUEUE_EMPTY)], effects: [] }
    }
    next = queued[0]!
  }

  const target = queueTarget(state, next.id)
  // queued → merging (validated); the effect carries exactly what the command needs.
  const event = stateChangeEvent(bay, next.id, "queued", "merging")
  const effect: Effect = { type: FX_MERGE_RUN, data: { pr: next.id, target } }
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
    const d = effect.data as { pr: PrId; target: string }

    // Read the PR's CURRENT state as the transition source. drain just set it
    // to `merging`; reading it (vs hardcoding) means a broken caller trips
    // assertTransition instead of silently mis-recording the outcome.
    const pr = (await bay.state()).prs[d.pr]
    if (!pr) throw new Error(`bay: merge.run: no PR '${d.pr}' in state`)
    const from = pr.state

    // Lying-merge guard, step 1 (G1.1): pin the target's SHA BEFORE the merge
    // command runs, so the post-merge ancestry question is about the exact
    // commit we asked to land — not whatever the branch points at afterwards.
    let targetSha: string | undefined
    if (opts.mainRepo) {
      const r = await git(["-C", opts.mainRepo, "rev-parse", "--verify", "--quiet", `${d.target}^{commit}`], opts.mainRepo)
      if (r.code !== 0) {
        return [
          stateChangeEvent(
            bay,
            d.pr,
            from,
            "rejected",
            `target '${d.target}' does not resolve in ${opts.mainRepo} — cannot verify a landing, refusing to run the merge. ` +
              `Fix the target (branch deleted? typo?) and retry: git bay retry ${d.pr}`,
          ),
        ]
      }
      targetSha = r.stdout.trim()
    }

    const mergeCommand = await resolveMergeCommand(opts)
    const cmd = mergeCommand
      .replaceAll("{target}", d.target)
      .replaceAll("{pr}", d.pr)
      .replaceAll("{changeset}", d.pr)

    // sh -c so the operator's own quoting works; never split on spaces. cwd is
    // mainRepo (Bun.spawn falls back to process.cwd() when it's undefined) so
    // mergeCommand doesn't need to hardcode `cd <path> &&`. A spawn failure
    // (no `sh`) throws — that is a broken host, not a merge verdict.
    const proc = Bun.spawn(["sh", "-c", cmd], { cwd: opts.mainRepo, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (code === 0) {
      // Lying-merge guard, step 2 (G1.1/G1.2): exit 0 is a CLAIM, not a landing.
      // Verify the pinned target is now an ancestor of the refreshed mainline;
      // otherwise journal rejected — a false `merged` is the exact class the
      // epic's AC4 promises is structurally impossible.
      if (opts.mainRepo && targetSha) {
        const baseRef = await resolveBaseRef(opts.mainRepo)
        const anc = await git(["-C", opts.mainRepo, "merge-base", "--is-ancestor", targetSha, baseRef], opts.mainRepo)
        if (anc.code !== 0) {
          return [
            stateChangeEvent(
              bay,
              d.pr,
              from,
              "rejected",
              `merge command exited 0 but ${d.target}@${targetSha.slice(0, 8)} is not an ancestor of ${baseRef} — ` +
                `refusing to record merged (lying-merge guard). If the landing is real but unpushed, push it and ` +
                `retry: git bay retry ${d.pr}. If the command lands by rebase/squash, use a merge-based ` +
                `landing — ancestry is the proof this guard accepts.`,
            ),
          ]
        }
      }
      return [stateChangeEvent(bay, d.pr, from, "merged", tail(stdout))]
    }
    // A non-zero merge command is a DOMAIN outcome (rejected), never a crash — do
    // not throw. The detail names the exit code and the stderr tail (law 7).
    const errTail = tail(stderr)
    const detail = errTail === "" ? `exit ${code}` : `exit ${code}: ${errTail}`
    return [stateChangeEvent(bay, d.pr, from, "rejected", detail)]
  }
}

// ---------- the plugin ----------

export function withMergeWorker(opts: MergeWorkerOptions = {}): BayPlugin {
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      // No apply: the merge worker emits pr.state-changed events that the
      // queue layer folds; it owns no state slice of its own.
      reduce(state, command, next) {
        if (command.type === "drain") return reduceDrain(bay, state, command)
        return next(state, command)
      },
      effects: {
        [FX_MERGE_RUN]: makeMergeRunHandler(opts),
      },
    }
    return bay.use(layer)
  }
}
