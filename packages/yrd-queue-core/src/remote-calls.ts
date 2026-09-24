/**
 * The remote calls a unit of work made, counted from git's own trace2 event log (25570 row 3).
 *
 * GitHub throttles SSH LOGINS from this host in bursts (25282), and one round reaches GitHub through three runners:
 * yrd's own Git (journaled), Gitomic's backend and git-super's children (neither journaled). With GIT_TRACE2_EVENT
 * naming a directory, every git process any of them starts writes its own event file there, because both
 * environment scrubbers keep GIT_TRACE2_* (yrd's ROUTING_VARIABLES, git-super's repository-pointer clean). So one
 * mechanism counts all three, and the count is git's, not a wrapper's opinion of what it ran.
 */
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** A git process's own verb when it talks to a remote. */
const REMOTE_VERBS = new Set(["clone", "fetch", "ls-remote", "pull", "push"])

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
}>

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
  for (const name of names) {
    let started = false
    let remote = false
    for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
      if (line === "") continue
      let event: { event?: unknown; name?: unknown; child_class?: unknown; t_abs?: unknown }
      try {
        event = JSON.parse(line) as typeof event
      } catch {
        // silent-fallback-allow: a torn line is COUNTED in `unreadable`, which the row carries.
        unreadable++
        continue
      }
      if (event.event === "start") started = true
      if (event.event === "cmd_name" && typeof event.name === "string" && REMOTE_VERBS.has(event.name)) {
        verbs[event.name] = (verbs[event.name] ?? 0) + 1
        remote = true
      }
      if (event.event === "child_start" && event.child_class === "transport/ssh") sshChildren++
      if (event.event === "exit" && remote && typeof event.t_abs === "number") remoteSeconds += event.t_abs
    }
    if (started) processes++
  }
  return { processes, verbs, sshChildren, remoteMs: Math.round(remoteSeconds * 1000), unreadable }
}

/**
 * Point every git process this process starts at `directory` until `end()`, which puts GIT_TRACE2_EVENT back and
 * counts what was recorded. The scopes that count, a round and a submit, run one at a time in a process; a caller
 * holding a Git built from an explicit environment adds `env` to it, since that Git never reads process.env again.
 */
export function traceRemoteCalls(
  directory: string,
): Readonly<{ env: Readonly<{ GIT_TRACE2_EVENT: string }>; end(): RemoteCalls }> {
  mkdirSync(directory, { recursive: true })
  const previous = process.env.GIT_TRACE2_EVENT
  process.env.GIT_TRACE2_EVENT = directory
  return {
    env: { GIT_TRACE2_EVENT: directory },
    end() {
      if (previous === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previous
      return readRemoteCalls(directory)
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
  }
}
