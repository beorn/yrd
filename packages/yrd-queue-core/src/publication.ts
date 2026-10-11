/** Child-first publication of a checked merge, shared by legacy and event markers. */
import type { Process } from "@yrd/process"
import { createLocalGitProcess } from "git-super/process"
import { readFrozenPushIntent } from "git-super/push-intent"
import { gitlinkRows, readRemoteCommit, type Git, type GitInvocationOptions } from "./git.ts"
import { requireFrozenGitSuper } from "./git-super-selection.ts"
import { gitSuperExecution, readSuperMergeDetail, type SuperMergeDetail } from "./verifying.ts"

export type ChildPublication = Readonly<{
  state: "published" | "refused"
  moved: readonly string[]
  evidence: string
  detail?: SuperMergeDetail
}>

/** The marker's CAS append has already retained candidate as a remote parent. */
export async function publishCheckedChildren(
  options: Readonly<{
    git: Git
    cwd: string
    candidate: string
    remote: string
    branch: string
    marker: Readonly<{ ref: string; tip: string }>
    process?: Process
    env?: NodeJS.ProcessEnv
    hooksPath?: string
    gitOptions?: GitInvocationOptions
  }>,
): Promise<ChildPublication> {
  // One fetch of the marker by name reads its tip AND brings the parent graph a
  // cold runner needs before Git-super can replay the exact frozen merge; it
  // changes no remote branch. `ls-remote <remote> <ref>` would carry the whole
  // advertisement to filter it here (25570).
  const observed = await readRemoteCommit(options.git, options.remote, options.marker.ref)
  if (observed !== options.marker.tip) {
    throw new Error(
      `publication marker ${options.remote} ${options.marker.ref}: expected ${options.marker.tip}, found ${observed ?? "absent"}`,
    )
  }
  await options.git(["cat-file", "-e", `${options.candidate}^{commit}`])
  const parents = (await options.git(["show", "-s", "--format=%P", options.marker.tip])).trim().split(/\s+/u)
  if (!parents.includes(options.candidate)) {
    throw new Error(`publication marker ${options.marker.tip} does not retain candidate ${options.candidate}`)
  }

  // The LOCAL half of the proof runs BEFORE git-super moves any child (28734): a
  // candidate whose changed gitlinks disagree with its own frozen intent is
  // refused here, so a refusal can no longer leave a component branch pushed
  // ahead of the root merge that is waiting on it.
  const plan = await readFrozenPublicationPlan(options)
  if (plan.disagreement !== undefined) {
    return {
      state: "refused",
      moved: [],
      evidence: `frozen push intent coverage refused before publication: ${plan.disagreement}`,
    }
  }

  // Git-super reads the frozen child intent and retains/verifies each source
  // before moving a child branch. Yrd neither decodes nor recreates that plan.
  const execution = await gitSuperExecution(
    {
      process: options.process,
      env: { ...(options.env ?? globalThis.process.env), GIT_SUPER_PROGRESS: "1" },
      hooksPath: options.hooksPath,
      gitOptions: options.gitOptions,
    },
    options.cwd,
    ["push", "--recurse-submodules=only", options.remote, `${options.candidate}:refs/heads/${options.branch}`],
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(execution.stdout)
  } catch (error) {
    throw new Error(
      `git-super push exited ${String(execution.exitCode)} without readable JSON: ${execution.stderr.trim() || execution.stdout.trim()}`,
      { cause: error },
    )
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("git-super push JSON is not an object")
  const result = parsed as Record<string, unknown>
  if (!new Set(["updated", "unchanged", "failed", "unknown"]).has(String(result.state))) {
    throw new Error(`git-super push JSON has invalid state ${String(result.state)}`)
  }
  if (typeof result.partial !== "boolean" || !Array.isArray(result.repositories)) {
    throw new Error("git-super push JSON has no boolean partial or repositories array")
  }
  const moved: string[] = []
  for (const repository of result.repositories) {
    if (typeof repository !== "object" || repository === null) {
      throw new Error("git-super push repository is not an object")
    }
    const row = repository as { repository?: unknown; refs?: unknown }
    if (typeof row.repository !== "string" || !Array.isArray(row.refs)) {
      throw new Error("git-super push repository is incomplete")
    }
    for (const ref of row.refs) {
      if (typeof ref !== "object" || ref === null) throw new Error("git-super push ref is not an object")
      const value = ref as { state?: unknown; destination?: unknown; source?: unknown }
      if (
        typeof value.state !== "string" ||
        typeof value.destination !== "string" ||
        typeof value.source !== "string"
      ) {
        throw new Error("git-super push ref is incomplete")
      }
      if (value.state === "updated") {
        moved.push(`${row.repository} ${value.destination} -> ${value.source.slice(0, 12)}`)
      }
    }
  }
  const detail = result.detail === undefined ? undefined : readSuperMergeDetail(result.detail)
  // Record the frozen tool in the existing publish evidence (27098 step 3): the
  // receipt names the absolute bin and the landing root's pin it was launched with.
  const frozen = requireFrozenGitSuper(
    options.env ?? globalThis.process.env,
    `git-super push of ${options.candidate.slice(0, 12)}`,
  )
  let evidence =
    `git-super ${frozen.bin}@${frozen.sha.slice(0, 12)} push exit ${String(execution.exitCode)} state=${String(result.state)} partial=${String(result.partial)}` +
    (detail === undefined ? "" : ` ${detail.code} (${detail.phase}): ${detail.message}`) +
    (moved.length === 0 ? "; nothing moved" : `; moved: ${moved.join(", ")}`)
  if (execution.exitCode === 0 && (result.state === "updated" || result.state === "unchanged") && !result.partial) {
    // The JSON is a claim, never the proof: confirm the expected child refs from
    // their remotes before recording published.
    const proof = await verifyRemoteChildRefs(options.git, plan.expected)
    if (proof.disagreement === undefined) return { state: "published", moved, evidence }
    evidence = `${evidence}; independent remote proof refused: ${proof.disagreement}`
    return { state: "refused", moved, evidence }
  }
  return { state: "refused", moved, evidence, ...(detail === undefined ? {} : { detail }) }
}

/** A child ref the frozen push intent expects to find on its remote after the push. */
type ExpectedChildRef = Readonly<{ destination: string; path: string; remote: string; source: string }>

/**
 * The LOCAL half of the independent publication proof (27098 step 4). The expected child
 * destinations come from the candidate's OWN frozen push intent joined with the root gitlinks it
 * changed against its first parent — never from git-super's success JSON. It reads only the
 * candidate commit, so the caller runs it BEFORE git-super pushes anything: a candidate whose
 * changed gitlinks disagree with its own frozen intent is refused with no child branch moved
 * (28734), instead of after a component has already landed.
 *
 * Only a gitlink the candidate STILL declares is a publication. A path the candidate takes out
 * (`newMode` 000000) pushes nothing, so it can never have a frozen push intent row, and demanding
 * one refuses every removal (28734). Same filter pin-carrier.ts applies to its own rows.
 */
async function readFrozenPublicationPlan(
  options: Readonly<{ git: Git; cwd: string; candidate: string; env?: NodeJS.ProcessEnv }>,
): Promise<Readonly<{ disagreement?: string; expected: readonly ExpectedChildRef[] }>> {
  const intent = await readFrozenPushIntent(
    createLocalGitProcess(options.env ?? globalThis.process.env),
    options.cwd,
    options.candidate,
  )
  const parents = (await options.git(["show", "-s", "--format=%P", options.candidate])).trim().split(/\s+/u)
  const firstParent = parents[0]
  const changed =
    firstParent === undefined || firstParent === ""
      ? []
      : (await gitlinkRows(options.git, firstParent, options.candidate))
          .filter((row) => row.newMode === "160000")
          .map((row) => row.path)
  const children = intent?.children ?? []
  const known = new Set(children.map((child) => child.path))
  const unexplained = changed.filter((path) => !known.has(path))
  if (unexplained.length > 0) {
    return {
      disagreement: `the candidate moved gitlink(s) ${unexplained.join(", ")} with no frozen push intent row`,
      expected: [],
    }
  }
  return {
    expected: children.flatMap((child) =>
      child.publication === undefined
        ? []
        : [
            {
              destination: child.publication.destination,
              path: child.path,
              remote: child.remote,
              source: child.publication.source,
            },
          ],
    ),
  }
}

/**
 * The REMOTE half of the proof: every expected child ref is read from its own remote and must equal
 * the frozen source. A well-formed `updated` with `repositories: []` cannot pass, and no expected
 * ref is silently skipped. Any disagreement (wrong value, absent ref, or unreadable remote)
 * refuses; there is no second push planner.
 */
async function verifyRemoteChildRefs(
  git: Git,
  expected: readonly ExpectedChildRef[],
): Promise<Readonly<{ disagreement?: string }>> {
  const disagreements: string[] = []
  for (const child of expected) {
    let observed: string | undefined
    try {
      observed = await readRemoteCommit(git, child.remote, child.destination)
    } catch (error) {
      disagreements.push(
        `${child.path} ${child.destination}: unreadable (${error instanceof Error ? error.message : String(error)})`,
      )
      continue
    }
    if (observed !== child.source) {
      disagreements.push(
        `${child.path} ${child.destination}: expected ${child.source.slice(0, 12)}, found ${
          observed === undefined ? "absent" : observed.slice(0, 12)
        }`,
      )
    }
  }
  return disagreements.length === 0 ? {} : { disagreement: disagreements.join("; ") }
}
