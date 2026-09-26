/**
 * Candidate ref naming, terminal-state deletion, and backlog sweeping (26022).
 *
 * Candidate refs exist under:
 * - `refs/heads/yrd/candidates/<sha>` (branch-shaped source-tip mirror)
 * - `refs/yrd/candidates/<sha>` (root candidate ref)
 *
 * Terminal states (merged, failed, withdrawn/dropped) delete their candidate refs
 * pinned with `--force-with-lease=<ref>:<sha>`.
 *
 * The sweep enumerates all existing candidate refs at the target remote, verifies
 * they point to their expected object SHA, preserves any ref associated with an active
 * queue change, and prunes the reclaimable population in bounded batches using
 * compare-and-swap leases.
 */

import type { Git } from "./git.ts"

export const SOURCE_CANDIDATE_REF_NAMESPACE = "refs/heads/yrd/candidates"
export const CANDIDATE_REF_NAMESPACE = "refs/yrd/candidates"

/** Source-tip mirror candidate ref name for a given commit SHA. */
export function sourceCandidateRefFor(sha: string): string {
  return `${SOURCE_CANDIDATE_REF_NAMESPACE}/${sha}`
}

/** Root candidate ref name for a given commit SHA. */
export function candidateRefFor(sha: string): string {
  return `${CANDIDATE_REF_NAMESPACE}/${sha}`
}

/** Both candidate ref names for a given commit SHA. */
export function candidateRefsFor(sha: string): readonly string[] {
  return [sourceCandidateRefFor(sha), candidateRefFor(sha)]
}

/** Whether a ref name belongs to either candidate ref namespace. */
export function isCandidateRef(ref: string): boolean {
  return ref.startsWith(`${SOURCE_CANDIDATE_REF_NAMESPACE}/`) || ref.startsWith(`${CANDIDATE_REF_NAMESPACE}/`)
}

export type DeleteCandidateRefResult = Readonly<{
  deleted: readonly string[]
  failed: readonly Readonly<{ ref: string; reason: string }>[]
}>

/**
 * Delete candidate refs for a list of commit SHAs (head, candidate, etc.)
 * on the given remote using pinned leases (--force-with-lease=<ref>:<sha>).
 * Safely ignores refs that do not exist on the remote.
 */
export async function deleteCandidateRefsForShas(
  git: Git,
  _repo: string,
  remote: string,
  shas: readonly string[],
): Promise<DeleteCandidateRefResult> {
  const deleted: string[] = []
  const failed: Array<{ ref: string; reason: string }> = []

  const validShas = shas.filter((sha) => /^[0-9a-f]{40}$/u.test(sha))
  if (validShas.length === 0) return { deleted: [], failed: [] }

  const patterns = validShas.flatMap((sha) => candidateRefsFor(sha))

  let listing: string
  try {
    listing = await git(["ls-remote", "--refs", remote, ...patterns])
  } catch (error) {
    return {
      deleted: [],
      failed: patterns.map((ref) => ({ ref, reason: `failed to inspect remote: ${String(error)}` })),
    }
  }

  const existing = new Map<string, string>()
  for (const line of listing.trim().split("\n")) {
    if (line === "") continue
    const [sha, ref] = line.split(/\s+/u)
    if (sha !== undefined && ref !== undefined && sha !== "") {
      existing.set(ref, sha)
    }
  }

  if (existing.size === 0) return { deleted: [], failed: [] }

  const leases: string[] = []
  const deletions: string[] = []
  const targets: Array<{ ref: string; sha: string }> = []

  for (const [ref, remoteSha] of existing) {
    leases.push(`--force-with-lease=${ref}:${remoteSha}`)
    deletions.push(`:${ref}`)
    targets.push({ ref, sha: remoteSha })
  }

  try {
    await git(["push", "--atomic", "--porcelain", ...leases, remote, ...deletions])
    for (const { ref } of targets) {
      deleted.push(ref)
    }
  } catch {
    // silent-fallback-allow: batched push failure falls back to per-ref delete to isolate conflicts
    for (const { ref, sha } of targets) {
      try {
        await git(["push", "--porcelain", `--force-with-lease=${ref}:${sha}`, remote, `:${ref}`])
        deleted.push(ref)
      } catch (singleError) {
        failed.push({
          ref,
          reason: singleError instanceof Error ? singleError.message : String(singleError),
        })
      }
    }
  }

  return { deleted, failed }
}

export type CandidateRefDiscovered = Readonly<{
  ref: string
  sha: string
  expectedSha?: string
  disposition: "live" | "reclaimable" | "mismatched"
  reason?: string
}>

export type CandidateRefSweepResult = Readonly<{
  scanned: number
  live: number
  reclaimable: number
  deleted: readonly string[]
  failed: readonly Readonly<{ ref: string; reason: string }>[]
  retained: readonly CandidateRefDiscovered[]
}>

export type SweepCandidateRefsOptions = Readonly<{
  repo: string
  remote?: string
  dryRun?: boolean
  batchSize?: number
  activeShas: ReadonlySet<string>
}>

const DEFAULT_SWEEP_BATCH_SIZE = 50

/**
 * Sweep candidate refs from the remote repository.
 * Inspects all refs under refs/heads/yrd/candidates/* and refs/yrd/candidates/*.
 * If dryRun is true, identifies reclaimable refs without deleting.
 * Otherwise, prunes reclaimable refs in chunks using --force-with-lease=<ref>:<sha>.
 */
export async function sweepCandidateRefs(
  git: Git,
  options: SweepCandidateRefsOptions,
): Promise<CandidateRefSweepResult> {
  const remote = options.remote ?? "origin"
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_SWEEP_BATCH_SIZE)
  const activeShas = options.activeShas

  let listing: string
  try {
    listing = await git([
      "ls-remote",
      "--refs",
      remote,
      `${SOURCE_CANDIDATE_REF_NAMESPACE}/*`,
      `${CANDIDATE_REF_NAMESPACE}/*`,
    ])
  } catch (error) {
    throw new Error(`cannot enumerate candidate refs at ${remote}: ${String(error)}`)
  }

  const discovered: CandidateRefDiscovered[] = []
  for (const line of listing.trim().split("\n")) {
    if (line === "") continue
    const [sha, ref] = line.split(/\s+/u)
    if (sha === undefined || ref === undefined || sha === "" || ref === "") continue

    const refSha = ref.slice(ref.lastIndexOf("/") + 1)
    if (activeShas.has(sha) || activeShas.has(refSha)) {
      discovered.push({ ref, sha, expectedSha: refSha, disposition: "live", reason: "named by active queue change" })
      continue
    }

    if (refSha !== sha) {
      discovered.push({
        ref,
        sha,
        expectedSha: refSha,
        disposition: "mismatched",
        reason: `ref object ${sha} does not match ref name ${refSha}`,
      })
      continue
    }

    discovered.push({ ref, sha, expectedSha: refSha, disposition: "reclaimable" })
  }

  const live = discovered.filter((d) => d.disposition === "live")
  const reclaimable = discovered.filter((d) => d.disposition === "reclaimable")
  const mismatched = discovered.filter((d) => d.disposition === "mismatched")

  const retained = [...live, ...mismatched]

  if (options.dryRun) {
    return {
      scanned: discovered.length,
      live: live.length,
      reclaimable: reclaimable.length,
      deleted: [],
      failed: [],
      retained,
    }
  }

  const deleted: string[] = []
  const failed: Array<{ ref: string; reason: string }> = []

  // Chunk deletions into bounded batches
  for (let i = 0; i < reclaimable.length; i += batchSize) {
    const chunk = reclaimable.slice(i, i + batchSize)
    const leases = chunk.map(({ ref, sha }) => `--force-with-lease=${ref}:${sha}`)
    const deletes = chunk.map(({ ref }) => `:${ref}`)

    try {
      await git(["push", "--atomic", "--porcelain", ...leases, remote, ...deletes])
      for (const { ref } of chunk) {
        deleted.push(ref)
      }
    } catch {
      // silent-fallback-allow: chunk push failure falls back to per-ref delete to isolate conflicts
      for (const { ref, sha } of chunk) {
        try {
          await git(["push", "--porcelain", `--force-with-lease=${ref}:${sha}`, remote, `:${ref}`])
          deleted.push(ref)
        } catch (singleError) {
          failed.push({
            ref,
            reason: singleError instanceof Error ? singleError.message : String(singleError),
          })
        }
      }
    }
  }

  return {
    scanned: discovered.length,
    live: live.length,
    reclaimable: reclaimable.length,
    deleted,
    failed,
    retained,
  }
}
