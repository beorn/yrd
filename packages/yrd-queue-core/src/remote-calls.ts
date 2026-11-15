/**
 * The remote calls a unit of work made, counted from git's own trace2 event log (25570 row 3).
 *
 * GitHub throttles SSH LOGINS from this host in bursts (25282), and one round reaches GitHub through three runners:
 * yrd's own Git (journaled), Gitomic's backend and git-super's children (neither journaled). With GIT_TRACE2_EVENT
 * naming a directory, every git process any of them starts writes its own event file there, because both
 * environment scrubbers keep GIT_TRACE2_* (yrd's ROUTING_VARIABLES, git-super's repository-pointer clean). So one
 * mechanism counts all three, and the count is git's, not a wrapper's opinion of what it ran.
 *
 * The directory says WHERE a process wrote, never WHO started it (34390): a repository path identifies a repository,
 * a clock reading orders two events, and neither names an owner. The capture token below is the ownership evidence,
 * and it travels beside GIT_TRACE2_EVENT through exactly the scrubbers that keep it; see REMOTE_CAPTURE_VARIABLE.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

/** A git process's own verb when it talks to a remote. */
const REMOTE_VERBS = new Set(["clone", "fetch", "ls-remote", "pull", "push"])
/**
 * The seam name yrd's own component-main read runs under (29730, @cto 316f70ff R2). The DERIVE boundary is what
 * this seam proves, and the refresh boundary is proven by git-super's own `GIT_SUPER_PHASE=refresh` marker: each
 * is a POSITIVE marker for its own half, and neither stands for the other. Shape alone never classifies: a fetch
 * carrying neither marker buckets as `beyond` on its own, and it is the ROUND's read that refuses to guess -
 * `requireRefreshTag` (readRemoteCalls' option, set from traceRemoteCalls' `refresh`) reports it unproven
 * rather than letting a round absorb an untagged refresh into its beyond bucket.
 */
export const DERIVE_COMPONENT_MAIN_SEAM = "deriveComponentMain"
const seamScope = new AsyncLocalStorage<string>()

/** Label the Git processes started by one submit read without changing process-wide state. */
export function withRemoteSeam<T>(name: string, action: () => T): T {
  if (!/^[a-zA-Z][a-zA-Z0-9.-]*$/u.test(name)) throw new TypeError(`invalid remote seam ${JSON.stringify(name)}`)
  return seamScope.run(name, action)
}

export function remoteSeam(): string | undefined {
  return seamScope.getStore()
}

/**
 * Label a call that no step names (29697, @cto R2), written at the CALLER's line and never inside a function
 * several callers share: a name written there labels every one of those callers by construction, and a new caller
 * then never shows as unattributed, so the ranking cannot say which line to cut. A step's own name always wins
 * wherever one is current, so this only fills the gap and never masks a caller that already has one.
 */
export function withRemoteSeamGap<T>(name: string, action: () => T): T {
  return seamScope.getStore() === undefined ? withRemoteSeam(name, action) : action()
}

/**
 * The capture's own name, recorded by git beside the event log (34390, @cto A-scope ruling). GIT_TRACE2_EVENT tells
 * a child where to write; this tells a reader which capture scope that child inherited, and inheritance is the only
 * causal link the log carries. It nests: a capture started inside another appends its own id to the chain, so work
 * a round causes through a nested submit or runner still names the round. yrd's ROUTING_VARIABLES and git-super's
 * repository-pointer clean keep every non-routing variable, so a child that keeps GIT_TRACE2_EVENT keeps this too.
 */
export const REMOTE_CAPTURE_VARIABLE = "YRD_REMOTE_CAPTURE"

/**
 * Who started the process that made one SSH call (34390). Decided from the capture chain alone: no repository path,
 * no clock reading and no phase label is ownership evidence.
 */
export type SshOwnership =
  /** The chain names this capture: a descendant of the scope that counted it, whatever repository it reached. */
  | "queue"
  /** A different capture's chain: positively not this scope's work, so disclosed and excluded, never silently dropped. */
  | "foreign"
  /** No chain at all: the capture reached the process but its owner cannot be proven, which is never a zero. */
  | "unknown"

/** One SSH child: its Git command, its repository, which part of the round it belongs to, and whose work it is. */
export type SshCall = Readonly<{
  command: string
  repository: string
  /** `refresh` is git-super's own refresh, `derive` the round's own component-main read, `beyond` anything else. */
  bucket: "refresh" | "derive" | "beyond"
  /** The capture chain this call's process carried, verbatim, or undefined when it carried none. */
  capture?: string
  /** Whose work this call is; `unknown` is reported as unproven and never read as zero queue cost. */
  ownership: SshOwnership
  /** Set when this call's split cannot be proven; the round's row reports it instead of a plausible zero. */
  unproven?: string
  sshChildren: number
}>

export type RemoteCalls = Readonly<{
  /** git processes that wrote an event file. */
  processes: number
  /** Remote verbs by name, one per process that ran it. */
  verbs: Readonly<Record<string, number>>
  /**
   * ssh transport CHILDREN started. Under ControlMaster a child that reuses the master is not a new login, so this
   * bounds the logins GitHub counts from above; the same measure before and after is what a comparison needs.
   */
  sshChildren: number
  /** Wall time of the remote-verb processes, summed from each one's own exit event. */
  remoteMs: number
  /** Event lines that did not parse: a process killed mid-write. Counted, never skipped silently. */
  unreadable: number
  /** Per-function remote verbs and transport children; `unattributed` is an explicit measurement gap. */
  seams: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** Each SSH child with its Git command and the part of the round it belongs to, before Trace2 is removed. */
  sshCalls: readonly SshCall[]
}>

/**
 * Whose work an SSH call is, from the capture chain its process recorded: `queue` when the chain names this
 * capture, `foreign` when it names another one, `unknown` when it names none. A foreign chain is positive evidence
 * that the process inherited someone else's capture, which is why it is the only arm that may be excluded.
 */
function describeOwnership(capture: string | undefined, ownCapture: string | undefined): SshOwnership {
  if (capture === undefined) return "unknown"
  if (ownCapture === undefined) return "unknown"
  return capture.split("/").includes(ownCapture) ? "queue" : "foreign"
}

function describeSshCall(
  command: string | undefined,
  repository: string | undefined,
  argv: readonly string[] | undefined,
  refresh: boolean,
  sshChildren: number,
  requireRefreshTag: boolean,
  seam: string | undefined,
  capture: string | undefined,
  ownCapture: string | undefined,
): SshCall {
  const ownership = describeOwnership(capture, ownCapture)
  // Git clone starts its SSH transport before it has a repository to report in def_repo.
  // Its exact SSH source is still present in the process's start argv.
  const cloneSources =
    command === "clone" && argv !== undefined
      ? argv.filter((arg) => arg.startsWith("ssh://") || /^[^@\s]+@[^:\s]+:/u.test(arg))
      : []
  // Bare Git has no worktree for def_repo. Gitomic explicitly names its absolute
  // git directory in start argv; implicit bare discovery is recorded below.
  const gitDirIndex = argv?.findIndex((arg) => arg === "--git-dir" || arg.startsWith("--git-dir=")) ?? -1
  const gitDirOption = gitDirIndex > 0 ? argv?.[gitDirIndex] : undefined
  const gitDirectory = gitDirOption === "--git-dir" ? argv?.[gitDirIndex + 1] : gitDirOption?.slice("--git-dir=".length)
  const namedRepository =
    repository ??
    (gitDirectory !== undefined && isAbsolute(gitDirectory) ? gitDirectory : undefined) ??
    (cloneSources.length === 1 ? cloneSources[0] : undefined)
  if (command === undefined || argv === undefined || namedRepository === undefined) {
    // This drops whatever tags the call carried, so an unknown command that also wore a refresh or derive
    // marker buckets as `beyond` here. That is safe only because roundRemoteCallsRow refuses a split carrying
    // any "unknown" command or repository BEFORE it groups a bucket, so such a call can never make a round's
    // refresh/derive/beyond counts read as measured; readers that only count verbs have no bucket to mislead.
    return {
      command: "unknown",
      repository: namedRepository ?? "unknown",
      bucket: "beyond",
      ownership,
      ...(capture === undefined ? {} : { capture }),
      sshChildren,
    }
  }
  const dryRun = argv.includes("--dry-run") ? " --dry-run" : ""
  const mainRef = argv.some((arg) => /^\+refs\/heads\/[^:]+:refs\/remotes\/origin\/[^:]+$/u.test(arg))
  const mainFetch = command === "fetch" && argv.includes("--no-tags") && mainRef
  const shaped: SshCall = {
    command: `${command}${dryRun}`,
    repository: namedRepository,
    bucket: "beyond",
    ownership,
    ...(capture === undefined ? {} : { capture }),
    sshChildren,
  }
  // 29730: each trip below used to throw out of `traced.end()` inside the row write, so the round lost its
  // whole attribution row AND its counts. The counts are evidence about the round; the row now carries them
  // and says in its own text that the split is unproven (@cto 316f70ff R1). The split is proven by a positive
  // marker only (R2), so no shape is ever absorbed into a bucket it did not name.
  if (refresh && !mainFetch) {
    return {
      ...shaped,
      unproven: `Trace2 tagged a non-component-main SSH call as refresh: ${command} in ${namedRepository}`,
    }
  }
  // The mirror trip, for the round's own name (@cto 316f70ff, fold 3): the derive seam is the round's own label
  // for a component-main read, so a call wearing it that is not component-main-shaped has no business in the
  // derive bucket - it reports unproven with its own reason instead of falling through as `beyond`.
  if (seam === DERIVE_COMPONENT_MAIN_SEAM && !mainFetch) {
    return {
      ...shaped,
      unproven: `Trace2 tagged a non-component-main SSH call as ${DERIVE_COMPONENT_MAIN_SEAM}: ${command} in ${namedRepository}`,
    }
  }
  if (!mainFetch) return shaped
  // 29730 review (@cto 1ce8f965): a call wearing BOTH markers is a contradiction, not a refresh. No path builds
  // one today - git-super sets its own phase and the seam names the round's own read - so it reports unproven
  // with its own reason instead of being silently counted as refresh on a tie-break nobody wrote down.
  if (refresh && seam === DERIVE_COMPONENT_MAIN_SEAM) {
    return {
      ...shaped,
      unproven: `Trace2 tagged one component-main fetch as both refresh and ${DERIVE_COMPONENT_MAIN_SEAM} in ${namedRepository}; round SSH split cannot be proven`,
    }
  }
  if (refresh) return { ...shaped, bucket: "refresh" }
  if (seam === DERIVE_COMPONENT_MAIN_SEAM) return { ...shaped, bucket: "derive" }
  if (requireRefreshTag) {
    return {
      ...shaped,
      unproven: `Trace2 found an untagged component-main refresh fetch in ${namedRepository}; round SSH split cannot be proven`,
    }
  }
  return shaped
}

/**
 * Count the remote calls recorded under one trace2 directory, and say which of them this capture owns. A directory
 * that is not there is refused. `capture` is this scope's own id: without it no call can be proven owned, so every
 * child reads `unknown` rather than being credited to the queue by default.
 */
export function readRemoteCalls(
  directory: string,
  options: Readonly<{ requireRefreshTag?: boolean; capture?: string }> = {},
): RemoteCalls {
  let names: string[]
  try {
    if (!statSync(directory).isDirectory()) throw new Error("not a directory")
    names = readdirSync(directory).sort()
  } catch (error) {
    throw new Error(
      `trace2 directory ${directory} cannot be read, so the remote calls it would count are unknown: ${String(error)}`,
      { cause: error },
    )
  }
  const verbs: Record<string, number> = {}
  let processes = 0
  let sshChildren = 0
  let remoteSeconds = 0
  let unreadable = 0
  const seams: Record<string, Record<string, number>> = {}
  const sshCalls: SshCall[] = []
  for (const name of names) {
    let started = false
    let remote = false
    let seam: string | undefined
    const fileVerbs: Record<string, number> = {}
    let fileSshChildren = 0
    let fileRemoteMs = 0
    let command: string | undefined
    let repository: string | undefined
    let refresh = false
    let capture: string | undefined
    let argv: readonly string[] | undefined
    for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
      if (line === "") continue
      let event: {
        event?: unknown
        name?: unknown
        child_class?: unknown
        t_abs?: unknown
        param?: unknown
        value?: unknown
        argv?: unknown
        worktree?: unknown
        category?: unknown
        key?: unknown
      }
      try {
        event = JSON.parse(line) as typeof event
      } catch {
        // silent-fallback-allow: a torn line is COUNTED in `unreadable`, which the row carries.
        unreadable++
        continue
      }
      if (event.event === "start") started = true
      if (event.event === "start" && Array.isArray(event.argv) && event.argv.every((arg) => typeof arg === "string")) {
        argv = event.argv as string[]
      }
      if (event.event === "def_repo" && typeof event.worktree === "string") repository = event.worktree
      if (
        event.event === "data" &&
        event.category === "setup" &&
        event.key === "implicit-bare-repository" &&
        typeof event.value === "string" &&
        isAbsolute(event.value)
      ) {
        repository = event.value
      }
      if (event.event === "def_param" && event.param === "GIT_SUPER_PHASE" && event.value === "refresh") refresh = true
      if (event.event === "def_param" && event.param === "YRD_SEAM" && typeof event.value === "string") {
        seam = event.value
      }
      if (
        event.event === "def_param" &&
        event.param === REMOTE_CAPTURE_VARIABLE &&
        typeof event.value === "string" &&
        event.value !== ""
      ) {
        capture = event.value
      }
      if (event.event === "cmd_name" && typeof event.name === "string" && REMOTE_VERBS.has(event.name)) {
        command = event.name
        verbs[event.name] = (verbs[event.name] ?? 0) + 1
        remote = true
        fileVerbs[event.name] = (fileVerbs[event.name] ?? 0) + 1
      }
      if (event.event === "child_start" && event.child_class === "transport/ssh") {
        sshChildren++
        fileSshChildren++
      }
      if (event.event === "exit" && remote && typeof event.t_abs === "number") {
        remoteSeconds += event.t_abs
        fileRemoteMs += Math.round(event.t_abs * 1000)
      }
    }
    if (fileSshChildren > 0) {
      sshCalls.push(
        describeSshCall(
          command,
          repository,
          argv,
          refresh,
          fileSshChildren,
          options.requireRefreshTag === true,
          seam,
          capture,
          options.capture,
        ),
      )
    }
    if (remote) {
      const row = (seams[seam ?? "unattributed"] ??= {})
      for (const [name, count] of Object.entries(fileVerbs)) row[name] = (row[name] ?? 0) + count
      row.ssh_children = (row.ssh_children ?? 0) + fileSshChildren
      row.remote_ms = (row.remote_ms ?? 0) + fileRemoteMs
    }
    if (started) processes++
  }
  return { processes, verbs, sshChildren, remoteMs: Math.round(remoteSeconds * 1000), unreadable, seams, sshCalls }
}

/**
 * Point every git process this process starts at `directory` until `end()`, which puts GIT_TRACE2_EVENT back, counts
 * what was recorded and removes `directory`, whether or not it could be read: the count is the evidence, and a round
 * that kept its trace2 log would add some hundreds of KB to the workdir every round for good. The scopes that count, a round and a submit, run one at a time in a process; a caller
 * holding a Git built from an explicit environment adds `env` to it, since that Git never reads process.env again.
 */
export function traceRemoteCalls(
  directory: string,
  options: Readonly<{ seams?: boolean; refresh?: boolean }> = {},
): Readonly<{ env: Readonly<NodeJS.ProcessEnv>; end(): RemoteCalls }> {
  mkdirSync(directory, { recursive: true })
  const previous = process.env.GIT_TRACE2_EVENT
  const previousVars = process.env.GIT_TRACE2_ENV_VARS
  const previousCapture = process.env[REMOTE_CAPTURE_VARIABLE]
  // The capture's own id, appended to whatever chain this process already carried (34390): a capture started
  // inside another names both, so a nested submit or runner stays this round's work instead of reading foreign.
  const capture = randomUUID()
  const chain = previousCapture === undefined || previousCapture === "" ? capture : `${previousCapture}/${capture}`
  process.env.GIT_TRACE2_EVENT = directory
  process.env[REMOTE_CAPTURE_VARIABLE] = chain
  // Always named, whatever the seam and refresh options: ownership is not an option of the capture, and a run
  // that did not record it could only ever report `unknown`.
  const recordedVars = [
    ...new Set([
      ...(previousVars?.split(",") ?? []),
      REMOTE_CAPTURE_VARIABLE,
      ...(options.seams ? ["YRD_SEAM"] : []),
      ...(options.refresh ? ["GIT_SUPER_PHASE"] : []),
    ]),
  ].join(",")
  process.env.GIT_TRACE2_ENV_VARS = recordedVars
  return {
    env: {
      GIT_TRACE2_EVENT: directory,
      GIT_TRACE2_ENV_VARS: recordedVars,
      [REMOTE_CAPTURE_VARIABLE]: chain,
    },
    end() {
      if (previous === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previous
      if (previousVars === undefined) delete process.env.GIT_TRACE2_ENV_VARS
      else process.env.GIT_TRACE2_ENV_VARS = previousVars
      if (previousCapture === undefined) delete process.env[REMOTE_CAPTURE_VARIABLE]
      else process.env[REMOTE_CAPTURE_VARIABLE] = previousCapture
      try {
        return readRemoteCalls(directory, { requireRefreshTag: options.refresh, capture })
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}

/** One line for a person: `processes=… ssh_children=… remote_ms=… unreadable=… fetch=… ls-remote=… push=…`. */
export function remoteCallsLine(calls: RemoteCalls): string {
  return Object.entries(remoteCallsRow(calls))
    .map(([name, count]) => `${name}=${String(count)}`)
    .join(" ")
}

/** The journal row's fields: flat, so a reader greps `ssh_children=` without decoding an object. */
export function remoteCallsRow(calls: RemoteCalls): Readonly<Record<string, number>> {
  return {
    processes: calls.processes,
    ssh_children: calls.sshChildren,
    remote_ms: calls.remoteMs,
    unreadable: calls.unreadable,
    ...Object.fromEntries(Object.entries(calls.verbs).map(([verb, count]) => [verb, count])),
    ...Object.fromEntries(
      Object.entries(calls.seams).flatMap(([seam, row]) =>
        Object.entries(row).map(([name, count]) => [`seam.${seam}.${name}`, count]),
      ),
    ),
  }
}

/**
 * The limit a merging round is measured against (ADR-0022, Receipt and target: "a merging round at most fifteen
 * beyond its refresh"). It is a journal measurement, never a refusal: no round fails on this number here.
 */
export const BEYOND_REFRESH_LIMIT = 15

/** The excluded children, one line per (command, repository, capture): the chain is the evidence, so it is named. */
function excludedLines(calls: readonly SshCall[]): readonly string[] {
  const grouped = new Map<string, { command: string; repository: string; capture: string; sshChildren: number }>()
  for (const call of calls) {
    const row = {
      command: call.command,
      repository: call.repository,
      capture: call.capture ?? "unknown",
      sshChildren: 0,
    }
    const key = JSON.stringify([row.command, row.repository, row.capture])
    const seen = grouped.get(key) ?? row
    seen.sshChildren += call.sshChildren
    grouped.set(key, seen)
  }
  return [...grouped.values()]
    .sort(
      (a, b) =>
        a.capture.localeCompare(b.capture) ||
        a.repository.localeCompare(b.repository) ||
        a.command.localeCompare(b.command),
    )
    .map((row) => `${row.sshChildren} ${row.command} @ ${row.repository} (capture ${row.capture})`)
}

/**
 * The round's causal ownership reconciliation (34390, @cto A-scope ruling). Every captured child is this capture's
 * work, another capture's, or unproven. These fields read the CAPTURE and nothing else, so a row whose phase split
 * is not proven may still carry them: a repository path and a clock reading are evidence about ownership neither.
 */
function captureRow(calls: RemoteCalls): Record<string, number | string | readonly string[]> {
  const children = (test: (call: SshCall) => boolean) =>
    calls.sshCalls.filter(test).reduce((sum, call) => sum + call.sshChildren, 0)
  const foreign = calls.sshCalls.filter((call) => call.ownership === "foreign")
  return {
    capture_boundary: `${REMOTE_CAPTURE_VARIABLE} chain on the trace2 capture`,
    capture_owned_ssh_children: children((call) => call.ownership === "queue"),
    capture_foreign_ssh_children: foreign.reduce((sum, call) => sum + call.sshChildren, 0),
    capture_unknown_ssh_children: children((call) => call.ownership === "unknown"),
    // Always present, so "nothing was excluded" is a statement the row makes rather than a field a reader misses.
    // Grouped like the split rows: one line per (command, repository, capture), never one line per child.
    excluded_calls: excludedLines(foreign),
  }
}

/**
 * The limit, applied to the round's OWN beyond-refresh children (34390). Only a row whose phase split is PROVEN may
 * call this: `beyond` is the placeholder bucket an unproven call wears, so a count taken here would publish a phase
 * the row has just refused to claim (@dev/10, 34390-51cc7384-peer). `unknown` ownership anywhere makes the verdict
 * `unproven` rather than a pass - an incomplete capture is never zero queue cost - and a foreign child is excluded
 * from the count while `excluded_calls` names it with the chain that proves the exclusion.
 */
function beyondRefreshRow(
  calls: RemoteCalls,
  limit: number | undefined,
): Record<string, number | string | readonly string[]> {
  const children = (test: (call: SshCall) => boolean) =>
    calls.sshCalls.filter(test).reduce((sum, call) => sum + call.sshChildren, 0)
  const beyondOwned = children((call) => call.ownership === "queue" && call.bucket === "beyond")
  const row: Record<string, number | string | readonly string[]> = {
    beyond_refresh_owned_ssh_children: beyondOwned,
    beyond_refresh_excluded_ssh_children: children((call) => call.ownership === "foreign" && call.bucket === "beyond"),
    beyond_refresh_unknown_ssh_children: children((call) => call.ownership === "unknown" && call.bucket === "beyond"),
  }
  if (limit !== undefined) {
    row.beyond_refresh_limit = limit
    const unknown = children((call) => call.ownership === "unknown")
    row.beyond_refresh_verdict = unknown > 0 ? "unproven" : beyondOwned > limit ? "over-limit" : "within-limit"
  }
  return row
}

/** A round's durable, exact split. A torn or unnamed SSH call cannot become a plausible zero. */
export function roundRemoteCallsRow(
  calls: RemoteCalls,
  options: Readonly<{ beyondRefreshLimit?: number }> = {},
): Readonly<Record<string, number | string | readonly string[]>> {
  if (calls.unreadable !== 0) {
    throw new Error(`round SSH split cannot be proven: ${calls.unreadable} unreadable Trace2 event(s)`)
  }
  if (calls.sshCalls.some((call) => call.command === "unknown" || call.repository === "unknown")) {
    throw new Error("round SSH split cannot be proven: a transport child lacks its Git command or repository")
  }
  const total = calls.sshCalls.reduce((sum, call) => sum + call.sshChildren, 0)
  if (total !== calls.sshChildren) {
    throw new Error(`round SSH split cannot be proven: named ${total} of ${calls.sshChildren} children`)
  }
  // 29730 (@cto 316f70ff R1): an unproven split journals its counts and says so in its own text, and omits
  // every split field, so a trip can never read as a plausible zero.
  const unproven = calls.sshCalls.filter(
    (call): call is SshCall & { unproven: string } => typeof call.unproven === "string",
  )
  if (unproven.length > 0) {
    // EVERY distinct reason, each named once (@cto 430b5daa): with the first match alone a round holding two
    // different trips reported only one of them, and a reader would hunt the wrong line; and the reason text names
    // its own repository, so two calls tripping the same trip in one repository are ONE reason, not two.
    const reasons = [...new Set(unproven.map((call) => call.unproven))]
    return {
      ...remoteCallsRow(calls),
      // Ownership is evidence about the capture, so it survives an unproven phase split. The BEYOND numbers do
      // not: `beyond` is the placeholder an unproven call wears, so a count or a verdict taken there would promote
      // a phase this row has just refused to claim. A supplied limit still reports itself, and it reports
      // `unproven`, because a row that cannot say which bucket failed a limit cannot say the limit was met either.
      ...captureRow(calls),
      ...(options.beyondRefreshLimit === undefined
        ? {}
        : { beyond_refresh_limit: options.beyondRefreshLimit, beyond_refresh_verdict: "unproven" }),
      ssh_split: "unproven",
      ssh_split_reason: reasons.join("; "),
    }
  }
  const group = (bucket: SshCall["bucket"]) => {
    const grouped = new Map<string, { command: string; repository: string; ssh_children: number }>()
    for (const call of calls.sshCalls) {
      if (call.bucket !== bucket) continue
      const key = JSON.stringify([call.command, call.repository])
      const row = grouped.get(key) ?? { command: call.command, repository: call.repository, ssh_children: 0 }
      row.ssh_children += call.sshChildren
      grouped.set(key, row)
    }
    return [...grouped.values()]
      .sort((a, b) => a.repository.localeCompare(b.repository) || a.command.localeCompare(b.command))
      .map((row) => `${row.ssh_children} ${row.command} @ ${row.repository}`)
  }
  const children = (bucket: SshCall["bucket"]) =>
    calls.sshCalls.filter((call) => call.bucket === bucket).reduce((sum, call) => sum + call.sshChildren, 0)
  const refreshChildren = children("refresh")
  const deriveChildren = children("derive")
  return {
    ...remoteCallsRow(calls),
    ...captureRow(calls),
    ...beyondRefreshRow(calls, options.beyondRefreshLimit),
    refresh_boundary: "GIT_SUPER_PHASE=refresh on component-main fetch",
    // The round's own component-main read, which names itself with a seam (@cto 316f70ff R2): its own bucket
    // beside the refresh, so a derivation round's split is provable instead of permanently unproven.
    derive_boundary: `YRD_SEAM=${DERIVE_COMPONENT_MAIN_SEAM} on component-main fetch`,
    refresh_ssh_children: refreshChildren,
    derive_ssh_children: deriveChildren,
    beyond_refresh_ssh_children: calls.sshChildren - refreshChildren - deriveChildren,
    refresh_calls: group("refresh"),
    derive_calls: group("derive"),
    beyond_refresh_calls: group("beyond"),
  }
}
