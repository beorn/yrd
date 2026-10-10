/** Event queue notifications and their bounded delivery transport. */
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createProcess, shellCommand, type Process } from "@yrd/process"
import { prepareWorktree, removeEmptyWorktreeRunDirectory } from "./worktree.ts"
import type { ObservationNotice, Git } from "./git.ts"
import type { Ending, Notifier } from "./config.ts"
import type { OverrideEntry } from "./override.ts"
import { short } from "./run.ts"

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
  | Readonly<{
      record: Exclude<Ending, "observed" | "override" | "retired-root-written">
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
      projectedMs?: number
      boundMs?: number
    }>
  | RetiredRootNotice

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
): Promise<readonly Readonly<{ name: string; delivery: Delivery; failure?: string; refused?: string }>[]> {
  return dispatchNotifications(context, "override", notice)
}

/**
 * Hand a retired-root notice to every `notify:` entry that wants it, outside any
 * round, exactly as an override notice is handed over: same worktree, same
 * entries. Nothing here throws for a notice; the sweep reports each delivery.
 */
export async function notifyRetiredRoot(
  context: OutsideRound,
  notice: RetiredRootNotice,
): Promise<readonly Readonly<{ name: string; delivery: Delivery; failure?: string; refused?: string }>[]> {
  return dispatchNotifications(context, "retired-root-written", notice)
}

/** Run the declaration's existing notify transport for an event-chain ending. */
export async function dispatchNotifications(
  context: OutsideRound,
  ending: Ending,
  notice: NotifyRecord,
): Promise<readonly Readonly<{ name: string; delivery: Delivery; failure?: string; refused?: string }>[]> {
  const wanted = context.notify.filter((entry) => entry.on.includes(ending))
  if (wanted.length === 0) return [{ delivery: "none", name: NOBODY }]
  await using resources = new AsyncDisposableStack()
  const runner = context.process ?? resources.use(createProcess({ cwd: context.repo }))
  const stamp = `notify-${String(Date.now())}-${String(process.pid)}-${randomUUID().slice(0, 8)}`
  const directory = join(context.workdir, "worktrees", stamp)
  resources.defer(() => removeEmptyWorktreeRunDirectory(directory))
  let prepared: Promise<Readonly<{ cwd: string; runner: Process }>> | undefined
  const environment = (): Promise<Readonly<{ cwd: string; runner: Process }>> => {
    prepared ??= (async () => {
      mkdirSync(directory, { recursive: true })
      const tree = await prepareWorktree(context.git, context.repo, context.targetSha, join(directory, "notify"), {
        targetSha: context.targetSha,
        process: runner,
        queueRun: true,
        ...(context.env === undefined ? {} : { env: context.env }),
        ...(context.populateReference === undefined ? {} : { populateReference: context.populateReference }),
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
      resources.defer(() => tree.remove())
      return { cwd: tree.path, runner }
    })()
    return prepared
  }
  const handed: Readonly<{ name: string; delivery: Delivery; failure?: string; refused?: string }>[] = []
  for (const entry of wanted) {
    handed.push({
      ...(await deliverWith(environment, context.targetSha, context.env, entry, notice)),
      name: entry.name,
    })
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
