import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const SUBMODULE_ALTERNATE_LOCATION = "superproject"
export const SUBMODULE_ALTERNATE_ERROR_STRATEGY = "info"
const MAX_CONCURRENT_SUBMODULE_UPDATES = 20

export type SubmoduleGitResult = Readonly<{ code: number; stdout: string; stderr: string }>

export type SubmoduleGit = Readonly<{
  run(repo: string, args: readonly string[], allowFailure?: boolean): Promise<SubmoduleGitResult>
  mutateConfig?(repo: string, args: readonly string[]): Promise<SubmoduleGitResult>
}>

export type SubmoduleMaterializationResult = SubmoduleGitResult &
  Readonly<{ borrowed: number; remoteFallbacks: number }>

export type SubmoduleMaterializationOptions = Readonly<{
  worktree: string
  referenceWorktree?: string
  force?: boolean
  log?: (message: string) => void
}>

const success = (): SubmoduleGitResult => ({ code: 0, stdout: "", stderr: "" })

export async function configureSubmoduleAlternatePolicy(git: SubmoduleGit, repo: string): Promise<SubmoduleGitResult> {
  for (const [key, value] of [
    ["submodule.alternateLocation", SUBMODULE_ALTERNATE_LOCATION],
    ["submodule.alternateErrorStrategy", SUBMODULE_ALTERNATE_ERROR_STRATEGY],
  ] as const) {
    const args = ["config", "--local", key, value]
    const configured =
      git.mutateConfig === undefined ? await git.run(repo, args, true) : await git.mutateConfig(repo, args)
    if (configured.code !== 0) return configured
  }
  return success()
}

type Submodule = Readonly<{ name: string; path: string }>

async function submodules(git: SubmoduleGit, repo: string): Promise<Submodule[] | SubmoduleGitResult> {
  const tracked = await git.run(repo, ["cat-file", "-e", "HEAD:.gitmodules"], true)
  if (tracked.code !== 0) return []
  const configured = await git.run(
    repo,
    ["config", "--blob", "HEAD:.gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    true,
  )
  if (configured.code === 1 && configured.stdout === "" && configured.stderr === "") return []
  if (configured.code !== 0) return configured
  return configured.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== "")
    .map((line): Submodule | undefined => {
      const match = /^(submodule\.(.+)\.path)\s+(.+)$/u.exec(line)
      return match?.[2] === undefined || match[3] === undefined ? undefined : { name: match[2], path: match[3] }
    })
    .filter((submodule): submodule is Submodule => submodule !== undefined)
}

async function requiredGitlink(git: SubmoduleGit, repo: string, path: string): Promise<string | undefined> {
  const tree = await git.run(repo, ["ls-tree", "HEAD", "--", path], true)
  if (tree.code !== 0) return undefined
  return /^160000 commit ([0-9a-f]+)\t/mu.exec(tree.stdout)?.[1]
}

async function referenceContains(git: SubmoduleGit, reference: string, sha: string): Promise<boolean> {
  return (await git.run(reference, ["cat-file", "-e", `${sha}^{commit}`], true)).code === 0
}

/**
 * Materialize isolated submodule checkouts while borrowing object history from
 * the matching checkout in Yrd's source repository. Git's documented
 * superproject alternate policy remains the fail-soft fallback for reference-
 * cloned roots; explicit per-path references close the linked-worktree gap.
 */
export async function materializeSubmodules(
  git: SubmoduleGit,
  options: SubmoduleMaterializationOptions,
): Promise<SubmoduleMaterializationResult> {
  const log = options.log ?? (() => {})
  const referenceRoot =
    options.referenceWorktree !== undefined && resolve(options.referenceWorktree) !== resolve(options.worktree)
      ? options.referenceWorktree
      : undefined
  let borrowed = 0
  let remoteFallbacks = 0

  const walk = async (worktree: string, reference: string | undefined): Promise<SubmoduleGitResult> => {
    const policy = await configureSubmoduleAlternatePolicy(git, worktree)
    if (policy.code !== 0) return policy

    const entries = await submodules(git, worktree)
    if (!Array.isArray(entries)) return entries
    const prepared: Array<Readonly<{ args: readonly string[]; nestedReference: string | undefined; path: string }>> = []
    for (const { name, path } of entries) {
      const required = await requiredGitlink(git, worktree, path)
      if (required === undefined) {
        return { code: 1, stdout: "", stderr: `could not resolve gitlink '${path}' in ${worktree}` }
      }
      const referenceSubmodule = reference === undefined ? undefined : join(reference, path)
      const canBorrow = referenceSubmodule !== undefined && (await referenceContains(git, referenceSubmodule, required))
      const initialized =
        git.mutateConfig === undefined
          ? await git.run(worktree, ["submodule", "init", "--", path], true)
          : await git.mutateConfig(worktree, ["submodule", "init", "--", path])
      if (initialized.code !== 0) return initialized
      const configuredUrl = await git.run(worktree, ["config", "--get", `submodule.${name}.url`], true)
      if (configuredUrl.code !== 0 || configuredUrl.stdout.trim() === "") {
        return {
          code: configuredUrl.code === 0 ? 1 : configuredUrl.code,
          stdout: configuredUrl.stdout,
          stderr: configuredUrl.stderr || `could not resolve configured URL for submodule '${name}' in ${worktree}`,
        }
      }
      const args = [
        "-c",
        `submodule.alternateLocation=${SUBMODULE_ALTERNATE_LOCATION}`,
        "-c",
        `submodule.alternateErrorStrategy=${SUBMODULE_ALTERNATE_ERROR_STRATEGY}`,
        ...(canBorrow
          ? [
              "-c",
              "protocol.file.allow=always",
              "-c",
              `url.${pathToFileURL(referenceSubmodule).href}.insteadOf=${configuredUrl.stdout.trim()}`,
            ]
          : []),
        "submodule",
        "update",
        "--init",
        ...(options.force ? ["--force"] : []),
        ...(canBorrow ? ["--reference", referenceSubmodule] : []),
        "--",
        path,
      ]
      if (canBorrow) {
        borrowed += 1
      } else if (referenceSubmodule !== undefined) {
        remoteFallbacks += 1
        log(`[submodules] ${path}: local store lacks ${required.slice(0, 12)}; using the configured remote fallback`)
      }
      prepared.push({ args, nestedReference: canBorrow ? referenceSubmodule : undefined, path })
    }
    for (let start = 0; start < prepared.length; start += MAX_CONCURRENT_SUBMODULE_UPDATES) {
      const results = await Promise.all(
        prepared.slice(start, start + MAX_CONCURRENT_SUBMODULE_UPDATES).map(async ({ args, nestedReference, path }) => {
          const updated = await git.run(worktree, args, true)
          return updated.code === 0 ? walk(join(worktree, path), nestedReference) : updated
        }),
      )
      const failed = results.find((result) => result.code !== 0)
      if (failed !== undefined) return failed
    }
    return success()
  }

  const result = await walk(options.worktree, referenceRoot)
  return { ...result, borrowed, remoteFallbacks }
}
