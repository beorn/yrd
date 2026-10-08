import { isAbsolute, relative, sep } from "node:path"
import {
  clearedByIdentity,
  inspectProcessCensus,
  inspectProcessCwds,
  type ProcessCwdProjection,
  type ProcessCensus,
  type UnreadableProcess,
} from "removely"
import type { YrdCliIO } from "./types.ts"

/** Shared admission policy: identity-cleared denials are evidence, an unexplained gap is not. */
export function processCwdCoverage(snapshot: ProcessCwdProjection) {
  const uncleared = snapshot.unreadable.filter((entry) => clearedByIdentity(entry) === undefined)
  const refusal =
    uncleared.length > 0
      ? `same-UID process CWD census ${snapshot.mechanism} could not read ${uncleared.map(unreadableLabel).join(", ")}; a holder among them cannot be ruled out`
      : !snapshot.complete && snapshot.unreadable.length === 0
        ? `same-UID process CWD census ${snapshot.mechanism} incomplete: no readable coverage`
        : undefined
  return { uncleared, refusal }
}

/** Name denial evidence without printing the identity argv, which can contain secrets. */
function unreadableLabel(entry: UnreadableProcess): string {
  const codes = [...new Set(entry.issues.flatMap((issue) => (issue.code === undefined ? [] : [issue.code])))]
  return `pid ${entry.pid} ${entry.comm ?? "(no comm)"}${codes.length === 0 ? "" : ` (${codes.join(", ")})`}`
}

export function environmentCwdHolder(
  path: string,
  snapshot: ProcessCwdProjection,
  exempt: ReadonlySet<number> = new Set(),
) {
  return snapshot.rows.find(({ pid, cwd }) => {
    if (exempt.has(pid)) return false
    const within = relative(path, cwd)
    return within === "" || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))
  })
}

/** Authoritative close admission, shared by direct close and the queue's close lifecycle. */
export async function admitEnvironmentClose(
  path: string,
  io: YrdCliIO,
  censusSource?: () => Promise<ProcessCensus<"same-uid">>,
): Promise<void> {
  let snapshot: ProcessCwdProjection
  const exempt = new Set<number>([process.pid])
  let ancestryAvailable = false
  let unreadableAncestor: number | undefined
  if (process.platform === "linux") {
    // The existing cwd projection derives these exact facts from this same collector.
    // Keep the ppid evidence alongside them so exemptions never come from another scan.
    const census = await (censusSource === undefined
      ? inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
      : censusSource())
    snapshot = {
      rows: census.rows.flatMap((row) => {
        const cwd = row.sources.cwd
        return cwd?.availability === "readable" && cwd.value !== undefined ? [{ pid: row.pid, cwd: cwd.value }] : []
      }),
      complete: census.coverage.complete,
      unreadable: census.coverage.unreadable ?? [],
      mechanism: "proc",
    }
    const rows = new Map(census.rows.map((row) => [row.pid, row]))
    let parent = rows.get(process.pid)?.ppid
    ancestryAvailable = parent !== undefined
    while (parent !== undefined && parent !== 0 && !exempt.has(parent)) {
      const row = rows.get(parent)
      // An unreadable or excluded ancestor is not proof for an exemption.
      if (row?.ppid === undefined) {
        unreadableAncestor = parent
        break
      }
      exempt.add(parent)
      parent = row.ppid
    }
  } else {
    snapshot = await inspectProcessCwds({ deadlineMs: 2_000 })
  }
  io.stderr(
    `yrd: env close ${snapshot.mechanism === "proc" ? "same-UID holders inspected; other-UID holders are not inspectable" : "lsof cwd holders inspected; UID scope and ancestry are unproven"}; exempt PIDs: ${[...exempt].join(", ")}. This scan is non-atomic: a process can enter after the check.\n`,
  )
  const coverage = processCwdCoverage(snapshot)
  const holder = environmentCwdHolder(path, snapshot, exempt)
  if (coverage.refusal !== undefined) {
    throw new Error(
      `${coverage.refusal}${holder === undefined ? "" : `; process ${holder.pid} has CWD ${holder.cwd}`}; environment ${path} was preserved`,
    )
  }
  const ownCwd =
    environmentCwdHolder(path, { ...snapshot, rows: snapshot.rows.filter((row) => row.pid === process.pid) }) !==
    undefined
  if ((!ancestryAvailable && ownCwd) || (holder !== undefined && holder.pid === unreadableAncestor)) {
    throw new Error(
      `ancestry unavailable${process.platform === "linux" ? " for this invocation" : " on this platform"}; own-cwd close refused; run the close from outside the environment; environment ${path} was preserved`,
    )
  }
  if (holder !== undefined) {
    throw new Error(
      `process ${holder.pid} has CWD ${holder.cwd}; environment ${path} was preserved; wait for its owner to leave before retrying`,
    )
  }
}
