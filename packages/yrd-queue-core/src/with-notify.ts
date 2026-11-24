/** Event queue notifications and their bounded delivery transport. */
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { type FlockHandle, tryAcquireFlock } from "@bearly/flock"
import { createProcess, shellCommand, type Process } from "@yrd/process"
import { WorktreePool, pooledWorktreePath } from "./pool.ts"
import type { ObservationNotice, Git, GitSelection } from "./git.ts"
import type { Ending, Notifier } from "./config.ts"
import type { OverrideEntry } from "./override.ts"
import { queueHooksPath, short } from "./run.ts"

const NOBODY = "none"

/** Show one re-cut with short commit names. */
function shortRecut(row: string): string {
  const parsed = /^(\S+) (\S+) \+ (\S+) -> (\S+)$/u.exec(row)
  if (parsed === null) return row
  const [, path, pin, main, composed] = parsed as unknown as [string, string, string, string, string]
  return `${path} ${pin.slice(0, 12)} + main ${main.slice(0, 12)} -> ${composed.slice(0, 12)}`
}

/** The one message an ended change sends, in the plan's three shapes (§ Commands). */
export function messageFor(
  kind: "merged" | "failed" | "stuck" | "deferred" | "cancelled",
  about: Readonly<{
    branch: string
    head: string
    subject: string
    merge?: string
    remedy?: string
    projectedMs?: number
    boundMs?: number
    /** The ending's `Recut` trailers: the queue composed these gitlinks itself (24977). */
    recuts?: readonly string[]
  }>,
): string {
  switch (kind) {
    case "merged": {
      const merged = `close your bead: ${short(about.branch, about.head)} merged as ${(about.merge ?? "").slice(0, 12)}`
      const recuts = about.recuts ?? []
      return recuts.length === 0 ? merged : `${merged}; the queue re-cut it: ${recuts.map(shortRecut).join("; ")}`
    }
    case "failed":
      return `send it back: ${about.subject}; ${about.remedy ?? ""}`.trim()
    case "stuck":
      return `yrd broken: ${about.subject}; the queue stays down until a person fixes it`
    case "cancelled":
      return `cancelled: ${short(about.branch, about.head)} is absent from the remote; push the branch and submit again if still wanted`
    case "deferred": {
      const projMin = about.projectedMs !== undefined ? Math.round(about.projectedMs / 60_000) : undefined
      const boundMin = about.boundMs !== undefined ? Math.round(about.boundMs / 60_000) : undefined
      const rel =
        about.projectedMs !== undefined && about.boundMs !== undefined
          ? about.projectedMs > about.boundMs
            ? ">"
            : about.projectedMs < about.boundMs
              ? "<"
              : "="
          : ">"
      const timing =
        projMin !== undefined && boundMin !== undefined
          ? `projected ${projMin}m ${rel} ${boundMin}m`
          : "projection exceeded bound"
      return `waits for long check: ${short(about.branch, about.head)} (${timing})`
    }
  }
}

export type NotifyRecord =
  | Readonly<{ record: "observed"; notice: ObservationNotice }>
  | OverrideNotice
  | EnvRetiredNotice
  | PostMergeAbandonedNotice
  | Readonly<{
      record: Exclude<Ending, "observed" | "override" | "retired-root-written" | "env-retired" | "post-merge-abandoned">
      change: string
      endingId: string
      endedAt: string
      submitter?: string
      issue?: string
      merge?: string
      reason?: string
      log?: string
      failures?: number
      /**
       * On a `failed` record only, and only when every prior failure of this
       * branch carried one and the same reason. The notifier's third
       * disposition — hold and route, do not resubmit — turns on this matching
       * `reason` (@i/10-yrd/24485). Absent means "not unambiguous", and the
       * notifier then says what it always said.
       */
      priorReason?: string
      /**
       * On a `failed` record only: the failing checks' identity — every failing
       * `Check:` row's name, exit and verdict, with the volatile fields
       * (attempt, phase, ms, log) dropped, all rows sorted by name and joined
       * with `; `. The cause the record already carries, and the notifier's
       * hold turns on it too (@cto 0ac17165 (B), 24735 row 5). Absent when the
       * ending carries no failing row, where the comparison stays on the
       * `reason` — a verifier refusal has no `Check:` row at all.
       */
      detail?: string
      /**
       * On a `failed` record only, and only when every prior charged failure of
       * this branch carried one and the same `detail` (mirroring
       * `priorReason`). Absent means "not unambiguous", and the notifier then
       * says what it always said.
       */
      priorDetail?: string
      projectedMs?: number
      boundMs?: number
    }>
  | RetiredRootNotice

/**
 * The env-retired occasion (29720): post-merge cleanup sealed and removed the
 * merged change's author environment. `environment` is the author folder that
 * is gone, `proof` the sealed retained-copy manifest that can rebuild it, and
 * `retainUntil` the instant that copy may be dropped. Housekeeping about a
 * change that already ended in a merge, so nothing is owed on this record;
 * it exists so the author hears where the folder went instead of finding it
 * gone.
 */
export type EnvRetiredNotice = Readonly<{
  record: "env-retired"
  change: string
  endingId: string
  endedAt: string
  submitter?: string
  issue?: string
  merge?: string
  environment: string
  /** The sealed retained copy's manifest, when a copy was kept. */
  proof?: string
  /** The instant that copy may be dropped. */
  retainUntil?: string
  /**
   * #38198: set instead of `proof`/`retainUntil` when the close proved no copy was needed — every head was on these
   * remote refs and the worktree was clean. A reader that asks "where did my work go" gets the refs, not an empty path.
   */
  notRetained?: Readonly<{ reason: string; provedBy: readonly string[] }>
}>

/**
 * The post-merge-abandoned occasion (37513, @cto 68bee3e1): a merged change's
 * post-merge issue update failed on `attempts` carried attempts, so the
 * service stopped carrying it. `reason` is the last attempt's failure and `log`
 * that attempt's evidence record. The merge stands; what is owed is the close,
 * rerun by a person, so the record asks its reader for that action.
 */
export type PostMergeAbandonedNotice = Readonly<{
  record: "post-merge-abandoned"
  /** The merged branch whose issue update was given up on. */
  change: string
  endingId: string
  endedAt: string
  submitter?: string
  issue?: string
  merge?: string
  reason: string
  log: string
  attempts: number
}>

/**
 * A retired `%23` queue root that received a write after the cutover
 * (28481 layer 3, @cto 6eb10b57). The sweep's own kind, not a change ending:
 * there is no `change`, and the record names the root, the newest file written
 * under it and that file's instant, and the cutover that makes the write a
 * fault. `active` is false on the clearing edge, once the newest write is older
 * than the clear window. Sent on the rail's `retired-root-written` occasion.
 */
export type RetiredRootNotice = Readonly<{
  record: "retired-root-written"
  /** The retired percent-escaped queue root that was written. */
  root: string
  /** The queue address in its `hh-dev%23main` form — the incident's subject. */
  address: string
  /** The newest regular file written under the root; the evidence line. */
  path: string
  /** That file's write instant, ISO with a zone. */
  writtenAt: string
  /** The cutover instant (`a9bf40062b`) that makes any later write a fault. */
  cutover: string
  /** Round-log environment names (`logs/environments/*`) — the nearest thing to a writer's name. */
  branches: readonly string[]
  /** False on the clearing edge: the root's newest write is older than the clear window. */
  active: boolean
}>

/**
 * A merge-check override event (25296, @cto ccd8dfa8), in the round's notify
 * shape: a JSON object on the entry's stdin. `target` is the queue target as
 * `<branch>@<sha>` when it happened, `round` the round that fired it (absent
 * for the verb's own set, clear and replace), `owner` who set the override,
 * `until` its expiry, and `override` the record commit it names.
 */
export type OverrideNotice = Readonly<{
  record: "override"
  action: "set" | "clear" | "replace" | "expired" | "reminder"
  check: string
  target: string
  round?: string
  owner: string
  verified: boolean
  until: string
  reason: string
  override: string
}>

/** The notice for one override entry and action. */
export function overrideNotice(
  entry: OverrideEntry,
  action: OverrideNotice["action"],
  target: string,
  round?: string,
): OverrideNotice {
  return {
    action,
    check: entry.check,
    override: entry.record,
    owner: entry.by,
    reason: entry.reason,
    record: "override",
    target,
    until: entry.until.toISOString(),
    verified: entry.verified,
    ...(round === undefined ? {} : { round }),
  }
}

export const RECUT_CHECK = "recut-check"

/**
 * Failed endings that are not the branch failing its checks again: a head the
 * submitter replaced or deleted, and a queue re-cut's check failure (24977
 * constraint 4 -- the attempt was the queue's, so it is never charged).
 */
const UNCHARGED = new Set(["replaced", "deleted", RECUT_CHECK])

/** Whether a failed ending with this Reason counts toward "failed twice with the same error". */
export function isChargedFailure(reason: string | undefined): boolean {
  return !UNCHARGED.has(reason ?? "")
}

/** Shared failure-reason classification for focused mutation coverage and prior failure folding. */
export function sameFailureReason(reasons: readonly (string | undefined)[]): string | undefined {
  // No length check: an empty list has no first element, and the absent-reason
  // guard below already refuses `undefined`. Mutation control found the extra
  // condition unkillable by any test, which is what an unreachable branch looks
  // like from the outside.
  const first = reasons[0]
  if (first === undefined || first === "") return undefined
  return reasons.every((reason) => reason === first) ? first : undefined
}

/**
 * The one check identity every prior failure carried, or nothing — the same
 * unambiguous-only fold as {@link sameFailureReason}, over `detail` (24735 row
 * 5). The two are folded separately and the notifier holds only when both
 * match, so a missing `detail` on either side leaves its text exactly as it
 * was and the hold can only fire less often.
 */
export function sameFailureDetail(details: readonly (string | undefined)[]): string | undefined {
  const first = details[0]
  if (first === undefined || first === "") return undefined
  return details.every((detail) => detail === first) ? first : undefined
}

/** How one notify entry went: it took the record, there was none to take it, or it exited non-zero. */
type Delivery = "sent" | "none" | "failed"

/**
 * The notify exit that says the transport answered and refused the send, with
 * the reason on the entry's last non-empty stdout line: never send this ending
 * to that name again. Not 3, which a check uses for cannot-judge.
 */
const REFUSED_EXIT = 4

/** How long one notify entry may run before the queue stops waiting for its answer. */
const NOTIFY_TIMEOUT_MS = 60_000

/**
 * The pool key for notifications outside a round. A workdir already belongs to one repository and one
 * queue ref, so this names a role-only slot beside the round's own candidate and base trees.
 */
const OUTSIDE_ROUND_REF = "outside-round"

/** How long a dispatch waits for another holder of the notify tree before its entries fail by name. */
const NOTIFY_TREE_WAIT_MS = 10 * 60_000

const NOTIFY_TREE_POLL_MS = 100

/** The lock beside the pooled notify tree; the pool never removes it, so it outlives a discarded tree. */
function notifyTreeLock(workdir: string): string {
  return `${pooledWorktreePath(workdir, OUTSIDE_ROUND_REF, "notify")}.lock`
}

/** The resolved Git selection a queue Git carries, which the pool needs to run Git inside its tree. */
function selectionOf(git: Git): GitSelection | undefined {
  return (git as Git & { readonly selection?: GitSelection }).selection
}

/**
 * Take the notify tree exclusively, waiting at most `waitMs` for another dispatch: a kernel flock, so a
 * holder that dies releases it, and a hold that outlasts the bound throws naming the lock and its holder.
 * That throw reaches each entry as a failed delivery, which retries as any failed delivery does.
 */
export async function holdNotifyTree(lock: string, waitMs: number): Promise<FlockHandle> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const handle = tryAcquireFlock(lock, {
      createParent: true,
      body: `${JSON.stringify({ pid: process.pid, command: process.argv.join(" "), since: new Date().toISOString() })}\n`,
    })
    if (handle !== null) return handle
    if (Date.now() >= deadline) {
      throw new Error(
        `the notify tree lock ${lock} was held past ${String(waitMs)}ms (holder: ${notifyTreeHolder(lock)})`,
      )
    }
    await sleep(NOTIFY_TREE_POLL_MS)
  }
}

function notifyTreeHolder(lock: string): string {
  try {
    return readFileSync(lock, "utf8").trim() || "no body written"
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Give one record to every `notify:` entry that wants this ending, in the order
 * the declaration lists them, and say how each went.
 *
 * An ending no entry wants is answered by one turn under the name `none` and
 * `Delivery: none` (ruling A4): the queue still records that it had something
 * to say and nobody to say it to, because an ending with no record at all reads
 * exactly like an ending nobody has got to yet.
 */
export type OutsideRound = Readonly<{
  git: Git
  repo: string
  /** The target commit the entry runs at: its tree, and its `setup:` first. */
  targetSha: string
  workdir: string
  /** The one generic temp root this notice's setup narrows to (27721); `<workdir>/tmp` when the environment supplied none. */
  tempRoot: string
  notify: readonly Notifier[]
  setup?: string
  env?: NodeJS.ProcessEnv
  populateReference?: boolean
  process?: Process
}>

/** How one entry answered one notice: the notice it was handed, and how that handing went. */
export type NotifyDelivery = Readonly<{
  notice: NotifyRecord
  name: string
  delivery: Delivery
  failure?: string
  refused?: string
}>

/**
 * Hand one override notice to every `notify:` entry that wants `override`,
 * outside any round, in a worktree at the target exactly as a round runs its
 * entries, and say how each went. Nothing here throws: a failed entry is a
 * `failed` delivery, never a failed override (@cto ccd8dfa8). No entry wanting
 * the event is one `none` delivery, named as such.
 */
export async function notifyOutsideRound(
  context: OutsideRound,
  notice: OverrideNotice,
): Promise<readonly NotifyDelivery[]> {
  return dispatchNotifications(context, "override", [notice])
}

/**
 * Hand a retired-root notice to every `notify:` entry that wants it, outside any
 * round, exactly as an override notice is handed over: same worktree, same
 * entries. Nothing here throws for a notice; the sweep reports each delivery.
 */
export async function notifyRetiredRoot(
  context: OutsideRound,
  notice: RetiredRootNotice,
): Promise<readonly NotifyDelivery[]> {
  return dispatchNotifications(context, "retired-root-written", [notice])
}

/**
 * Hand env-retired notices to every `notify:` entry that wants them, outside
 * any round — post-merge environment cleanup watches no round either. One
 * cleanup pass retires several environments; they travel in one dispatch so
 * the worktree is prepared once, not once per folder. The retirements
 * already happened; this only ever tells, never gates.
 */
export async function notifyEnvRetired(
  context: OutsideRound,
  notices: readonly EnvRetiredNotice[],
): Promise<readonly NotifyDelivery[]> {
  return dispatchNotifications(context, "env-retired", notices)
}

/**
 * Hand post-merge-abandoned notices to every `notify:` entry that wants them,
 * outside any round, as env-retired notices are. Never gates: the merges stand.
 */
export async function notifyPostMergeAbandoned(
  context: OutsideRound,
  notices: readonly PostMergeAbandonedNotice[],
): Promise<readonly NotifyDelivery[]> {
  return dispatchNotifications(context, "post-merge-abandoned", notices)
}

/**
 * Run the declaration's existing notify transport for an event-chain ending:
 * every notice to every entry that wants the ending, notices in the order
 * given, entries in declaration order, all over the one worktree this
 * dispatch prepares. Each notice keeps its own deliveries (each result names
 * its notice), and one failed delivery never stops the rest. No notices is
 * no dispatch: nothing is prepared and nobody is owed a `none`.
 */
export async function dispatchNotifications(
  context: OutsideRound,
  ending: Ending,
  notices: readonly NotifyRecord[],
): Promise<readonly NotifyDelivery[]> {
  if (notices.length === 0) return []
  const wanted = context.notify.filter((entry) => entry.on.includes(ending))
  if (wanted.length === 0) return notices.map((notice) => ({ notice, delivery: "none" as const, name: NOBODY }))
  await using resources = new AsyncDisposableStack()
  const runner = context.process ?? resources.use(createProcess({ cwd: context.repo }))
  // The checkout is shared between dispatches; the setup's log and temp are not.
  const stamp = `notify-${String(Date.now())}-${String(process.pid)}-${randomUUID().slice(0, 8)}`
  let prepared: Promise<Readonly<{ cwd: string; runner: Process }>> | undefined
  const environment = (): Promise<Readonly<{ cwd: string; runner: Process }>> => {
    prepared ??= (async () => {
      // 34755: one warm tree per workdir, borrowed and given back, instead of a fresh full checkout per
      // dispatch (each one wrote ~3 GB, ~400 a day). The exclusive hold spans the borrow, every entry and
      // the return, because the round lock does not: a round releases it before its post-merge
      // notifications, and admission and override CLI calls dispatch from their own processes.
      const hold = await holdNotifyTree(notifyTreeLock(context.workdir), NOTIFY_TREE_WAIT_MS)
      resources.defer(() => hold.release())
      const selection = selectionOf(context.git)
      const pool = new WorktreePool({
        workdir: context.workdir,
        ref: OUTSIDE_ROUND_REF,
        repo: context.repo,
        git: context.git,
        hooksPath: queueHooksPath(context.workdir),
        // A refused reuse falls back to a fresh full checkout, the ~3 GB write this pool exists to avoid, so its
        // cause is named on stderr like the round's own, never swallowed.
        note: (cause) => process.stderr.write(`yrd notify: ${cause}; building a fresh notify tree\n`),
        process: runner,
        ...(context.env === undefined ? {} : { env: context.env }),
        ...(selection === undefined ? {} : { selection }),
        ...(context.populateReference === undefined ? {} : { populateReference: context.populateReference }),
      })
      const tree = await pool.borrow({
        role: "notify",
        commit: context.targetSha,
        targetSha: context.targetSha,
        ...(context.setup === undefined
          ? {}
          : {
              setup: {
                run: context.setup,
                logDir: join(context.workdir, "checks", "notify", stamp),
                tmpdir: join(context.tempRoot, "notify", stamp),
              },
            }),
      })
      // Registered after the hold, so it runs before the release. A failed return never undoes a
      // delivery already made; the next borrow resets and cleans again, so it is reported, not thrown.
      resources.defer(async () => {
        try {
          await pool.give(tree)
        } catch (error) {
          process.stderr.write(
            `yrd notify: returning the notify tree ${tree.path} failed after its deliveries were made; the next borrow resets it: ${error instanceof Error ? error.message : String(error)}\n`,
          )
        }
      })
      return { cwd: tree.path, runner }
    })()
    return prepared
  }
  const handed: NotifyDelivery[] = []
  for (const notice of notices) {
    for (const entry of wanted) {
      handed.push({
        ...(await deliverWith(environment, context.targetSha, context.env, entry, notice)),
        notice,
        name: entry.name,
      })
    }
  }
  return handed
}

async function deliverWith(
  environment: () => Promise<Readonly<{ cwd: string; runner: Process }>>,
  targetSha: string,
  env: NodeJS.ProcessEnv | undefined,
  entry: Notifier,
  record: NotifyRecord,
): Promise<Readonly<{ delivery: Delivery; failure?: string; refused?: string }>> {
  try {
    const { cwd, runner } = await environment()
    const result = await runner.run({
      argv: shellCommand(entry.run),
      cwd,
      env,
      stdin: `${JSON.stringify(record)}\n`,
      timeoutMs: NOTIFY_TIMEOUT_MS,
    })
    if (result.exitCode === 0) return { delivery: "sent" }
    const bound = result.timedOut ? ` ran past its ${String(NOTIFY_TIMEOUT_MS)}ms bound and` : ""
    const failure =
      `the notify entry ${entry.name} in ${cwd}${bound} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`.replace(
        /\s+/gu,
        " ",
      )
    // An entry the bound killed gave no answer, whatever it printed first.
    if (result.exitCode !== REFUSED_EXIT || result.timedOut) return { delivery: "failed", failure }
    const reason = result.stdout
      .split(/\r\n|\n|\r/u)
      .map((line) => line.trim())
      .findLast((line) => line !== "")
    return {
      delivery: "failed",
      failure,
      refused: reason ?? `exited ${String(REFUSED_EXIT)}, the refusal exit, and printed no reason on stdout`,
    }
  } catch (error) {
    return {
      delivery: "failed",
      failure: `the notify entry ${entry.name} at queue commit ${targetSha} could not run: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
