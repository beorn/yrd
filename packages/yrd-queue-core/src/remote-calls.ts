/**
 * The remote calls a unit of work made, counted from git's own trace2 event log (25570 row 3).
 *
 * GitHub throttles SSH LOGINS from this host in bursts (25282), and one round reaches GitHub through three runners:
 * yrd's own Git (journaled), Gitomic's backend and git-super's children (neither journaled). With GIT_TRACE2_EVENT
 * naming a directory, every git process any of them starts writes its own event file there, because both
 * environment scrubbers keep GIT_TRACE2_* (yrd's ROUTING_VARIABLES, git-super's repository-pointer clean). So one
 * mechanism counts all three, and the count is git's, not a wrapper's opinion of what it ran.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"

/** A git process's own verb when it talks to a remote. */
const REMOTE_VERBS = new Set(["clone", "fetch", "ls-remote", "pull", "push"])
const seamScope = new AsyncLocalStorage<string>()

/** Label the Git processes started by one submit read without changing process-wide state. */
export function withRemoteSeam<T>(name: string, action: () => T): T {
  if (!/^[a-zA-Z][a-zA-Z0-9.-]*$/u.test(name)) throw new TypeError(`invalid remote seam ${JSON.stringify(name)}`)
  return seamScope.run(name, action)
}

export function remoteSeam(): string | undefined {
  return seamScope.getStore()
}

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
  /** Each SSH child with its Git command and the explicit git-super refresh tag, before Trace2 is removed. */
  sshCalls: readonly Readonly<{ command: string; repository: string; refresh: boolean; sshChildren: number }>[]
}>

function describeSshCall(
  command: string | undefined,
  repository: string | undefined,
  argv: readonly string[] | undefined,
  refresh: boolean,
  sshChildren: number,
): RemoteCalls["sshCalls"][number] {
  if (command === undefined || argv === undefined || repository === undefined) {
    return { command: "unknown", repository: repository ?? "unknown", refresh, sshChildren }
  }
  const dryRun = argv.includes("--dry-run") ? " --dry-run" : ""
  const mainRef = argv.some((arg) => /^\+refs\/heads\/[^:]+:refs\/remotes\/origin\/[^:]+$/u.test(arg))
  const mainFetch = command === "fetch" && argv.includes("--no-tags") && argv.includes("origin") && mainRef
  if (refresh) {
    if (!mainFetch) {
      throw new Error(`Trace2 tagged a non-component-main SSH call as refresh: ${command} in ${repository}`)
    }
  } else if (mainFetch) {
    throw new Error(
      `Trace2 found an untagged component-main refresh fetch in ${repository}; round SSH split cannot be proven`,
    )
  }
  return { command: `${command}${dryRun}`, repository, refresh, sshChildren }
}

/** Count the remote calls recorded under one trace2 directory. A directory that is not there is refused. */
export function readRemoteCalls(directory: string): RemoteCalls {
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
  const sshCalls: { command: string; repository: string; refresh: boolean; sshChildren: number }[] = []
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
      if (event.event === "def_param" && event.param === "GIT_SUPER_PHASE" && event.value === "refresh") refresh = true
      if (event.event === "def_param" && event.param === "YRD_SEAM" && typeof event.value === "string") {
        seam = event.value
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
      sshCalls.push(describeSshCall(command, repository, argv, refresh, fileSshChildren))
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
  process.env.GIT_TRACE2_EVENT = directory
  if (options.seams || options.refresh) {
    process.env.GIT_TRACE2_ENV_VARS = [
      ...new Set([
        ...(previousVars?.split(",") ?? []),
        ...(options.seams ? ["YRD_SEAM"] : []),
        ...(options.refresh ? ["GIT_SUPER_PHASE"] : []),
      ]),
    ].join(",")
  }
  return {
    env: {
      GIT_TRACE2_EVENT: directory,
      ...(options.seams || options.refresh ? { GIT_TRACE2_ENV_VARS: process.env.GIT_TRACE2_ENV_VARS } : {}),
    },
    end() {
      if (previous === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previous
      if (options.seams || options.refresh) {
        if (previousVars === undefined) delete process.env.GIT_TRACE2_ENV_VARS
        else process.env.GIT_TRACE2_ENV_VARS = previousVars
      }
      try {
        return readRemoteCalls(directory)
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

/** A round's durable, exact split. A torn or unnamed SSH call cannot become a plausible zero. */
export function roundRemoteCallsRow(calls: RemoteCalls): Readonly<Record<string, number | string | readonly string[]>> {
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
  const group = (refresh: boolean) => {
    const grouped = new Map<string, { command: string; repository: string; ssh_children: number }>()
    for (const call of calls.sshCalls) {
      if (call.refresh !== refresh) continue
      const key = JSON.stringify([call.command, call.repository])
      const row = grouped.get(key) ?? { command: call.command, repository: call.repository, ssh_children: 0 }
      row.ssh_children += call.sshChildren
      grouped.set(key, row)
    }
    return [...grouped.values()]
      .sort((a, b) => a.repository.localeCompare(b.repository) || a.command.localeCompare(b.command))
      .map((row) => `${row.ssh_children} ${row.command} @ ${row.repository}`)
  }
  const refreshCalls = group(true)
  const beyondCalls = group(false)
  const refreshChildren = calls.sshCalls.filter((call) => call.refresh).reduce((sum, call) => sum + call.sshChildren, 0)
  return {
    ...remoteCallsRow(calls),
    refresh_boundary: "GIT_SUPER_PHASE=refresh on component-main fetch",
    refresh_ssh_children: refreshChildren,
    beyond_refresh_ssh_children: calls.sshChildren - refreshChildren,
    refresh_calls: refreshCalls,
    beyond_refresh_calls: beyondCalls,
  }
}
