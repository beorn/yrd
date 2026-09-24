/** Child-first publication of a checked merge, shared by legacy and event markers. */
import type { Process } from "@yrd/process"
import type { Git } from "./git.ts"
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
  }>,
): Promise<ChildPublication> {
  const observed = (await options.git(["ls-remote", "--refs", options.remote, options.marker.ref]))
    .trim()
    .split(/\s+/u)[0]
  if (observed !== options.marker.tip) {
    throw new Error(
      `publication marker ${options.remote} ${options.marker.ref}: expected ${options.marker.tip}, found ${observed ?? "absent"}`,
    )
  }
  // A cold runner needs the marker's parent graph locally before Git-super can
  // replay the exact frozen merge. This fetch changes no remote branch.
  await options.git(["fetch", "--quiet", "--no-tags", options.remote, options.marker.ref])
  await options.git(["cat-file", "-e", `${options.candidate}^{commit}`])
  const parents = (await options.git(["show", "-s", "--format=%P", options.marker.tip])).trim().split(/\s+/u)
  if (!parents.includes(options.candidate)) {
    throw new Error(`publication marker ${options.marker.tip} does not retain candidate ${options.candidate}`)
  }

  // Git-super reads the frozen child intent and retains/verifies each source
  // before moving a child branch. Yrd neither decodes nor recreates that plan.
  const execution = await gitSuperExecution(
    { process: options.process, env: options.env, hooksPath: options.hooksPath },
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
  const evidence =
    `git-super push exit ${String(execution.exitCode)} state=${String(result.state)} partial=${String(result.partial)}` +
    (detail === undefined ? "" : ` ${detail.code} (${detail.phase}): ${detail.message}`) +
    (moved.length === 0 ? "; nothing moved" : `; moved: ${moved.join(", ")}`)
  if (execution.exitCode === 0 && (result.state === "updated" || result.state === "unchanged") && !result.partial) {
    return { state: "published", moved, evidence }
  }
  return { state: "refused", moved, evidence, ...(detail === undefined ? {} : { detail }) }
}
