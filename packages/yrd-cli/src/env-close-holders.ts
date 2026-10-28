import { isAbsolute, parse, relative, sep } from "node:path"
import { realpathSync } from "node:fs"
import {
  clearedByIdentity,
  inspectProcessCensus,
  inspectProcessCwds,
  isStrictlyInside,
  resolveContainedPath,
  type ProcessCwdProjection,
  type ProcessCensus,
  type UnreadableProcess,
} from "removely"
import type { YrdCliIO } from "./types.ts"

export function validateLiveEnvironmentUses(uses: unknown): readonly Readonly<{ path: string; reason: string }>[] {
  if (!Array.isArray(uses)) throw new Error("live environment-use reader did not return an array")
  return uses.map((use: unknown) => {
    if (
      typeof use !== "object" ||
      use === null ||
      !("path" in use) ||
      typeof use.path !== "string" ||
      !isAbsolute(use.path) ||
      !("reason" in use) ||
      typeof use.reason !== "string" ||
      use.reason.trim() === ""
    ) {
      throw new Error("live environment-use reader needs absolute paths and nonempty reasons")
    }
    return { path: use.path, reason: use.reason }
  })
}

export async function assertNoLiveEnvironmentUse(path: string, io: YrdCliIO): Promise<void> {
  if (io.liveEnvironmentUse === undefined) return
  let uses: ReturnType<typeof validateLiveEnvironmentUses>
  try {
    uses = validateLiveEnvironmentUses(await io.liveEnvironmentUse(path)).map((use) => ({
      path: resolveContainedPath(use.path, parse(use.path).root, { allowRoot: true }),
      reason: use.reason,
    }))
  } catch (cause) {
    throw new Error(`live environment-use reader unavailable: ${String(cause)}`, { cause })
  }
  const holder = uses.find((use) => use.path === path || isStrictlyInside(use.path, path))
  if (holder !== undefined) throw new Error(`live use: ${holder.reason} (${holder.path})`)
}

/** Shared admission policy: identity-cleared denials are evidence, an unexplained gap is not. */
export function processCwdCoverage(snapshot: ProcessCwdProjection) {
  const uncleared = snapshot.unreadable.filter((entry) => clearedByIdentity(entry) === undefined)
  // A pid cleared by identity is a waiver, so it is named with the identity that cleared it (29772 row 3).
  const cleared = snapshot.unreadable.flatMap((entry) => {
    const identity = clearedByIdentity(entry)
    return identity === undefined ? [] : [`${unreadableLabel(entry)} as ${identity}`]
  })
  const refusal =
    uncleared.length > 0
      ? `same-UID process CWD census ${snapshot.mechanism} could not read ${uncleared.map(unreadableLabel).join(", ")}; a holder among them cannot be ruled out`
      : !snapshot.complete && snapshot.unreadable.length === 0
        ? `same-UID process CWD census ${snapshot.mechanism} incomplete: no readable coverage`
        : undefined
  return { uncleared, cleared, refusal }
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
  let target: string
  try {
    target = realpathSync(path)
  } catch (cause) {
    throw new Error(
      `environment ${path} cannot resolve its cwd containment target; environment was preserved; inspect its path before retrying`,
      { cause },
    )
  }
  return snapshot.rows.find(({ pid, cwd }) => {
    if (exempt.has(pid)) return false
    const within = relative(target, cwd)
    return within === "" || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))
  })
}

/** The census facts one admission read, named so a refusal can carry them to a capable context. */
export type CloseCensusReceipt = Readonly<{
  mechanism: string
  complete: boolean
  rows: number
  unreadable: number
  uncleared: number
}>

/**
 * What one admission decided.
 *
 * `admitted` may proceed. `needs-delegation` means this invocation's census
 * could NOT certify the close and no readable holder was found: the caller is
 * not permitted to quietly proceed, and refusing outright would leave the
 * environment to a human, so the intent is delegated to a context whose census
 * reads every pid (22894). A readable holder is never delegation — it is a
 * refusal, exactly as before (28120).
 */
export type CloseAdmission =
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "needs-delegation"; refusal: string; census: CloseCensusReceipt }>

/** Authoritative close admission, shared by direct close and the queue's close lifecycle. */
export async function admitEnvironmentClose(
  path: string,
  io: YrdCliIO,
  censusSource?: () => Promise<ProcessCensus<"same-uid">>,
): Promise<CloseAdmission> {
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
  const coverage = processCwdCoverage(snapshot)
  io.stderr(
    `yrd: env close ${snapshot.mechanism === "proc" ? "same-UID holders inspected; other-UID holders are not inspectable" : "lsof cwd holders inspected; UID scope and ancestry are unproven"}; exempt PIDs: ${[...exempt].join(", ")}; identity-cleared unreadable PIDs: ${coverage.cleared.length === 0 ? "none" : coverage.cleared.join(", ")}. This scan is non-atomic: a process can enter after the check.\n`,
  )
  const holder = environmentCwdHolder(path, snapshot, exempt)
  if (coverage.refusal !== undefined) {
    // A READABLE holder inside the path is a refusal, exactly as before: the
    // caller knows the pid and the cwd and can name them. Incomplete coverage
    // with NO readable holder is the case this invocation cannot decide, and it
    // is delegated rather than guessed either way.
    if (holder !== undefined) {
      throw new Error(
        `${coverage.refusal}; process ${holder.pid} has CWD ${holder.cwd}; environment ${path} was preserved`,
      )
    }
    return {
      kind: "needs-delegation",
      refusal: coverage.refusal,
      census: {
        mechanism: snapshot.mechanism,
        complete: snapshot.complete,
        rows: snapshot.rows.length,
        unreadable: snapshot.unreadable.length,
        uncleared: coverage.uncleared.length,
      },
    }
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
  return { kind: "admitted" }
}
