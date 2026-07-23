import { createHash } from "node:crypto"

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu
const REVIEW_TRAILER = "Yrd-Composition-Review"

type GitResult = Readonly<{
  code: number
  stdout: string
  stderr: string
  signal: string | null
  timedOut: boolean
  stalled?: boolean
  verdict?: "EXITED" | "TIMED_OUT" | "STALLED"
  sweepFailure?: string
}>

export type QueueSubmoduleMergeWitnessGit = Readonly<{
  probe(repo: string, args: readonly string[]): Promise<GitResult>
  rawProbe(repo: string, args: readonly string[]): Promise<GitResult>
}>

export type QueueSubmoduleMergeReviewConflict = Readonly<{
  path: string
  reason: "content-conflict" | "noncanonical-tree"
  resolution: "first-parent" | "second-parent" | "combined" | "manual"
  baseOid?: string
  firstParentOid?: string
  secondParentOid?: string
  resultOid?: string
}>

export type QueueSubmoduleMergeWitness =
  | Readonly<{ status: "witnessed"; kind: "not-a-two-parent-merge" | "canonical" | "reviewed" }>
  | Readonly<{
      status: "review-required"
      mergeSha: string
      parents: readonly string[]
      tree: string
      conflicts: readonly QueueSubmoduleMergeReviewConflict[]
      requiredTrailer: string
    }>

/**
 * Witness an already-authored merge commit against Git's materialized merge.
 *
 * A canonical tree needs no human claim. Conflicted or manually altered trees
 * require an exact content-addressed trailer, so amending any parent, stage, or
 * result blob invalidates the prior review.
 */
export async function witnessQueueSubmoduleMerge(
  git: QueueSubmoduleMergeWitnessGit,
  store: string,
  mergeSha: string,
): Promise<QueueSubmoduleMergeWitness> {
  const commit = await requiredGit(git, store, ["cat-file", "commit", mergeSha], "read merge commit", false)
  const headerEnd = commit.indexOf("\n\n")
  if (headerEnd < 0) throw new Error(`merge '${mergeSha}' has no commit-message boundary`)
  const parents = [...commit.slice(0, headerEnd).matchAll(/^parent ([0-9a-f]{40,64})$/gmu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  )
  if (parents.length !== 2) return { status: "witnessed", kind: "not-a-two-parent-merge" }
  const firstParent = parents[0]
  const secondParent = parents[1]
  if (firstParent === undefined || secondParent === undefined) throw new Error("merge parents disappeared")

  const tree = objectId(
    await requiredGit(git, store, ["show", "-s", "--format=%T", mergeSha], "read merge tree"),
    "read merge tree",
  )
  const merged = await git.rawProbe(store, ["merge-tree", "--write-tree", "-z", firstParent, secondParent])
  if (!settled(merged)) throw new Error(gitDetail(merged))
  if (merged.code !== 0 && merged.code !== 1) throw new Error(gitDetail(merged))

  const records = merged.stdout.split("\0")
  const canonicalTree = objectId(records[0] ?? "", "materialize parent merge")
  if (merged.code === 0 && canonicalTree === tree) return { status: "witnessed", kind: "canonical" }

  const conflicts =
    merged.code === 1
      ? await conflictFacts(git, store, mergeSha, records)
      : await noncanonicalFacts(git, store, canonicalTree, tree)
  const requiredTrailer = reviewTrailer(parents, tree, conflicts)
  const message = commit.slice(headerEnd + 2)
  if (message.split(/\r?\n/u).includes(requiredTrailer)) {
    return { status: "witnessed", kind: "reviewed" }
  }
  return { status: "review-required", mergeSha, parents, tree, conflicts, requiredTrailer }
}

async function conflictFacts(
  git: QueueSubmoduleMergeWitnessGit,
  store: string,
  mergeSha: string,
  records: readonly string[],
): Promise<QueueSubmoduleMergeReviewConflict[]> {
  const stages = new Map<string, Map<number, string>>()
  for (const record of records.slice(1)) {
    if (record === "") break
    const separator = record.indexOf("\t")
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([123])$/u.exec(record.slice(0, separator))
    if (separator < 1 || match?.[2] === undefined || match[3] === undefined) {
      throw new Error(`materialized merge returned malformed conflict stage '${record}'`)
    }
    const path = record.slice(separator + 1)
    const byStage = stages.get(path) ?? new Map<number, string>()
    byStage.set(Number(match[3]), match[2])
    stages.set(path, byStage)
  }
  if (stages.size === 0) throw new Error("materialized merge reported a conflict without conflict stages")

  const conflicts: QueueSubmoduleMergeReviewConflict[] = []
  for (const [path, byStage] of [...stages].sort(([left], [right]) => compareText(left, right))) {
    const firstParentOid = byStage.get(2)
    const secondParentOid = byStage.get(3)
    const resultOid = await objectAtPath(git, store, mergeSha, path)
    const resolution =
      resultOid !== undefined && resultOid === firstParentOid
        ? "first-parent"
        : resultOid !== undefined && resultOid === secondParentOid
          ? "second-parent"
          : "combined"
    conflicts.push({
      path,
      reason: "content-conflict",
      resolution,
      ...(byStage.get(1) === undefined ? {} : { baseOid: byStage.get(1) }),
      ...(firstParentOid === undefined ? {} : { firstParentOid }),
      ...(secondParentOid === undefined ? {} : { secondParentOid }),
      ...(resultOid === undefined ? {} : { resultOid }),
    })
  }
  return conflicts
}

async function noncanonicalFacts(
  git: QueueSubmoduleMergeWitnessGit,
  store: string,
  canonicalTree: string,
  tree: string,
): Promise<QueueSubmoduleMergeReviewConflict[]> {
  const changed = await requiredGit(
    git,
    store,
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", canonicalTree, tree],
    "enumerate noncanonical merge paths",
    false,
  )
  const paths = changed
    .split("\0")
    .filter((path) => path !== "")
    .toSorted(compareText)
  if (paths.length === 0) throw new Error("merge tree differs from its canonical merge without changed paths")
  return paths.map((path) => ({ path, reason: "noncanonical-tree", resolution: "manual" }))
}

async function objectAtPath(
  git: QueueSubmoduleMergeWitnessGit,
  store: string,
  commit: string,
  path: string,
): Promise<string | undefined> {
  const output = await requiredGit(
    git,
    store,
    ["ls-tree", "-z", commit, "--", path],
    `read merged path '${path}'`,
    false,
  )
  if (output === "") return undefined
  const separator = output.indexOf("\t")
  const match = /^([0-7]{6}) (?:blob|commit|tree) ([0-9a-f]{40,64})$/u.exec(output.slice(0, separator))
  if (separator < 1 || match?.[2] === undefined || output.slice(separator + 1, -1) !== path) {
    throw new Error(`merged path '${path}' is not a single tree entry`)
  }
  return match[2]
}

function reviewTrailer(
  parents: readonly string[],
  tree: string,
  conflicts: readonly QueueSubmoduleMergeReviewConflict[],
): string {
  const digest = createHash("sha256")
    .update("yrd-submodule-merge-review-v1\0")
    .update(JSON.stringify({ version: 1, parents, tree, conflicts }))
    .digest("hex")
  return `${REVIEW_TRAILER}: sha256:${digest}`
}

async function requiredGit(
  git: QueueSubmoduleMergeWitnessGit,
  store: string,
  args: readonly string[],
  operation: string,
  trim = true,
): Promise<string> {
  const result = trim ? await git.probe(store, args) : await git.rawProbe(store, args)
  if (!settled(result) || result.code !== 0) throw new Error(`${operation} failed: ${gitDetail(result)}`)
  return trim ? result.stdout.trim() : result.stdout
}

function objectId(output: string, operation: string): string {
  const oid = output.trim()
  if (!OBJECT_ID.test(oid)) throw new Error(`${operation} returned invalid object identity '${oid}'`)
  return oid
}

function settled(result: GitResult): boolean {
  return (
    !result.timedOut &&
    result.signal === null &&
    result.stalled !== true &&
    (result.verdict === undefined || result.verdict === "EXITED") &&
    result.sweepFailure === undefined
  )
}

function gitDetail(result: GitResult): string {
  const output = result.stderr.trim() || result.stdout.trim() || `git exited ${result.code}`
  if (result.sweepFailure !== undefined) return `process sweep failed (${result.sweepFailure}): ${output}`
  if (result.stalled) return `git stalled: ${output}`
  if (result.timedOut) return `git timed out: ${output}`
  if (result.signal !== null) return `git terminated by ${result.signal}: ${output}`
  return output
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
