/** Remote identity and branch advertisement checks shared by event queues. */
import type { Git } from "./git.ts"

/** Root-only witnesses from the same advertisement as the queue records. */
export type QueueObservation = Readonly<{
  checked: readonly Readonly<{ mergeOid: string; recordRef: string; recordOid: string }>[]
  fence: Readonly<{ prefixes: readonly string[]; refs: readonly Readonly<{ ref: string; oid: string }>[] }>
}>

/** Confirm a branch omitted by a broad remote listing before treating it as deleted. */
export const DEFAULT_BRANCH_DELETION_GRACE_MS = 75_000

export type BranchOmission = Readonly<{
  branch: string
  answer: "present" | "absent" | "error"
  ms: number
  protected: boolean
  remainingMs: number
  error?: string
}>

/** Repair one broad remote advertisement for its open submitted branches. */
export async function repairMissingBranchHeads(
  listed: ReadonlyMap<string, string>,
  open: readonly Readonly<{ branch: string; openedAt: number }>[],
  remote: string,
  listExact: (ref: string) => Promise<ReadonlyMap<string, string>>,
  now: () => number = Date.now,
  graceMs = DEFAULT_BRANCH_DELETION_GRACE_MS,
): Promise<Readonly<{ heads: Map<string, string>; omissions: readonly BranchOmission[] }>> {
  if (!Number.isFinite(graceMs) || graceMs < 60_000) {
    throw new Error(`${remote}: branch deletion confirmation needs a grace window of at least 60 seconds`)
  }
  const heads = new Map(listed)
  const omissions: BranchOmission[] = []
  const checked = new Set<string>()
  let checkedAt: number | undefined
  for (const change of open) {
    const ref = `refs/heads/${change.branch}`
    if (!Number.isFinite(change.openedAt)) throw new Error(`${remote} ${ref}: opening time is not readable`)
    if (listed.has(ref) || checked.has(ref)) continue
    checked.add(ref)
    checkedAt ??= now()
    if (!Number.isFinite(checkedAt)) {
      throw new Error(`${remote} ${ref}: branch deletion confirmation clock is not finite`)
    }
    const started = Date.now()
    let answer: BranchOmission["answer"]
    let error: string | undefined
    try {
      const exact = (await listExact(ref)).get(ref)
      if (exact === undefined) answer = "absent"
      else {
        heads.set(ref, exact)
        answer = "present"
      }
    } catch (cause) {
      answer = "error"
      error = `${remote} ${ref}: ${cause instanceof Error ? cause.message : String(cause)}`
    }
    const remainingMs = Math.max(0, change.openedAt + graceMs - checkedAt)
    omissions.push({
      branch: change.branch,
      answer,
      ms: Date.now() - started,
      protected: answer === "error" || (answer === "absent" && remainingMs > 0),
      remainingMs,
      ...(error === undefined ? {} : { error }),
    })
  }
  return { heads, omissions }
}

/** The remotes this repository has, by name. */
export async function remoteNames(git: Git): Promise<readonly string[]> {
  return (await git(["remote"]))
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "")
}

/** The declared transport address, before Git's transport-only URL rewriting. */
export async function remoteUrl(git: Git, remote: string): Promise<string> {
  if (!(await remoteNames(git)).includes(remote)) {
    if (remote.includes(":") || remote.includes("/")) return remote
    throw new Error(`queue remote ${remote}: no configured remote or transport address`)
  }
  // Fetch uses the first URL; scalar config lookup returns the last. Keep
  // that same identity before insteadOf rewrites only the transport address.
  const url = (await git(["config", "--null", "--get-all", `remote.${remote}.url`])).split("\0")[0]
  if (url === undefined || url === "") {
    throw new Error(`queue remote ${remote}: expected remote.${remote}.url is missing or empty`)
  }
  return url
}

const YRD = "yrd"

/**
 * The remote name for a declared `remote:`: the name itself when the
 * repository has it; else the declaration is a URL and the remote is `yrd`,
 * added at that URL when missing (§ The change: `yrd submit` adds the `yrd`
 * remote from `.yrd.yml` when missing). A name that is neither is loud.
 */
export async function resolveRemote(git: Git, declared: string): Promise<string> {
  const names = await remoteNames(git)
  if (names.includes(declared)) return declared
  if (!declared.includes(":") && !declared.includes("/")) {
    throw new Error(`.yrd.yml remote: ${declared} is neither a remote of this repository nor a URL`)
  }
  if (names.includes(YRD)) {
    const url = await remoteUrl(git, YRD)
    if (url !== declared) throw new Error(`the remote ${YRD} is at ${url}, not at the declared ${declared}`)
    return YRD
  }
  await git(["remote", "add", YRD, declared])
  return YRD
}
