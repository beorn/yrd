import { createHash } from "node:crypto"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Process } from "@yrd/process"
import { cleanGitEnvironment } from "./git-environment.ts"
import { yrdSourceRoot } from "./version.ts"

const GIT_TIMEOUT_MS = 30_000

export type ImplementationSourceRepository = Readonly<{
  root: string
}>

export type ImplementationSourceCheckoutRelation =
  | Readonly<{ kind: "ancestor-lag"; repository: string; pinnedSha: string }>
  | Readonly<{ kind: "checkout-ahead" }>
  | Readonly<{ kind: "divergent" }>
  | Readonly<{ kind: "unprovable" }>

function gitSourceSha(identity: string | undefined): string | undefined {
  const match = /^git:([0-9a-f]{40,64})$/u.exec(identity ?? "")
  return match?.[1]
}

async function isAncestor(
  process: Pick<Process, "run">,
  repository: ImplementationSourceRepository,
  ancestor: string,
  descendant: string,
): Promise<boolean | undefined> {
  const args = ["merge-base", "--is-ancestor", ancestor, descendant]
  const result = await process.run({
    argv: ["git", "-C", repository.root, ...args],
    cwd: repository.root,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (result.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  return undefined
}

/** Classify a clean implementation checkout against the authoritative pin.
 * Neither direction is assumed: a stale root checkout can make the gitlink
 * older than the component checkout, while two independently authored lines
 * can be genuinely divergent. */
export async function implementationSourceCheckoutRelation(
  process: Pick<Process, "run">,
  repository: ImplementationSourceRepository,
  workingTree: string | undefined,
  pinned: string | undefined,
): Promise<ImplementationSourceCheckoutRelation> {
  const currentSha = gitSourceSha(workingTree)
  const pinnedSha = gitSourceSha(pinned)
  if (currentSha === undefined || pinnedSha === undefined) return { kind: "unprovable" }
  if (currentSha === pinnedSha) return { kind: "unprovable" }
  const lags = await isAncestor(process, repository, currentSha, pinnedSha)
  if (lags === true) return { kind: "ancestor-lag", repository: repository.root, pinnedSha }
  if (lags === undefined) return { kind: "unprovable" }
  const ahead = await isAncestor(process, repository, pinnedSha, currentSha)
  if (ahead === true) return { kind: "checkout-ahead" }
  return ahead === false ? { kind: "divergent" } : { kind: "unprovable" }
}

/** Find the owning Yrd source checkout for one loaded module without doing I/O
 * at import time. The package-root boundary prevents an installed node_modules
 * copy from inheriting a consumer repository's HEAD. */
export function sourceRepositoryFor(moduleUrl: string): ImplementationSourceRepository | undefined {
  const modulePath = fileURLToPath(moduleUrl)
  const root = yrdSourceRoot(dirname(modulePath))
  return root === undefined ? undefined : { root }
}

function sourceIdentity(sha: string): string {
  return `git:${sha.toLowerCase()}`
}

async function superprojectSourcePath(
  process: Pick<Process, "run">,
  repository: string,
  sourceRepository: ImplementationSourceRepository,
): Promise<string | undefined> {
  const args = ["rev-parse", "--path-format=absolute", "--show-superproject-working-tree"]
  const result = await process.run({
    argv: ["git", "-C", sourceRepository.root, ...args],
    cwd: sourceRepository.root,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (result.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `yrd: could not inspect the runtime source superproject`)
  }

  const superproject = result.stdout.trim()
  if (superproject === "") return undefined
  if (!isAbsolute(superproject)) {
    throw new Error(`yrd: runtime source superproject is not an absolute path`)
  }
  const sourceCommon = await process.run({
    argv: ["git", "-C", superproject, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd: superproject,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  const authorityCommon = await process.run({
    argv: ["git", "-C", repository, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd: repository,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (sourceCommon.timedOut || authorityCommon.timedOut) {
    throw new Error(`yrd: runtime source repository-identity probe timed out after ${GIT_TIMEOUT_MS}ms`)
  }
  if (sourceCommon.exitCode !== 0 || authorityCommon.exitCode !== 0) {
    throw new Error(
      sourceCommon.stderr.trim() ||
        authorityCommon.stderr.trim() ||
        `yrd: could not compare runtime source and queue authority repositories`,
    )
  }
  if (resolve(sourceCommon.stdout.trim()) !== resolve(authorityCommon.stdout.trim())) return undefined

  const sourcePath = relative(resolve(superproject), resolve(sourceRepository.root))
  if (sourcePath === "" || sourcePath === "." || sourcePath === ".." || sourcePath.startsWith(`..${sep}`)) {
    throw new Error(`yrd: runtime source is not contained by its reported superproject`)
  }
  return sourcePath
}

async function commit(process: Pick<Process, "run">, repository: string, ref: string): Promise<string | undefined> {
  const args = ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]
  const result = await process.run({
    argv: ["git", "-C", repository, ...args],
    cwd: repository,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (result.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  if (result.exitCode !== 0) return undefined
  const sha = result.stdout.trim()
  return /^[0-9a-f]{40,64}$/iu.test(sha) ? sha.toLowerCase() : undefined
}

/** Identity of the Yrd source checkout at the instant this probe runs.
 *
 * The host calls this once at startup and preserves that result as the loaded
 * identity. Its environment audit calls the same owner again before each
 * admission to detect a mutable source checkout moving underneath lazy imports. */
export async function implementationSourceIdentity(
  process: Pick<Process, "run">,
  sourceRepository?: ImplementationSourceRepository,
): Promise<string | undefined> {
  if (sourceRepository === undefined) return undefined
  const owned = await process.run({
    argv: ["git", "-C", sourceRepository.root, "rev-parse", "--show-toplevel"],
    cwd: sourceRepository.root,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (owned.timedOut) throw new Error(`yrd: runtime source ownership probe timed out after ${GIT_TIMEOUT_MS}ms`)
  if (owned.exitCode !== 0 || resolve(owned.stdout.trim()) !== resolve(sourceRepository.root)) {
    return undefined
  }
  const sha = await commit(process, sourceRepository.root, "HEAD")
  if (sha === undefined) throw new Error(`yrd: loaded runtime source '${sourceRepository.root}' has no HEAD commit`)
  const untrackedArgs = ["ls-files", "--others", "--exclude-standard", "-z"]
  const untracked = await process.run({
    argv: ["git", "-C", sourceRepository.root, ...untrackedArgs],
    cwd: sourceRepository.root,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (untracked.timedOut) {
    throw new Error(`yrd: runtime source untracked-file probe timed out after ${GIT_TIMEOUT_MS}ms`)
  }
  if (untracked.exitCode !== 0) {
    throw new Error(untracked.stderr.trim() || `yrd: could not inspect untracked runtime source files`)
  }
  const untrackedManifest: string[] = []
  for (const path of untracked.stdout.split("\0").filter((entry) => entry !== "")) {
    const hashed = await process.run({
      argv: ["git", "-C", sourceRepository.root, "hash-object", "--no-filters", "--", path],
      cwd: sourceRepository.root,
      env: cleanGitEnvironment(globalThis.process.env),
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (hashed.timedOut) {
      throw new Error(`yrd: runtime source hash for '${path}' timed out after ${GIT_TIMEOUT_MS}ms`)
    }
    const hash = hashed.stdout.trim()
    if (hashed.exitCode !== 0 || !/^[0-9a-f]{40,64}$/iu.test(hash)) return undefined
    untrackedManifest.push(`${path}\0${hash.toLowerCase()}`)
  }
  const diffArgs = ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]
  const diff = await process.run({
    argv: ["git", "-C", sourceRepository.root, ...diffArgs],
    cwd: sourceRepository.root,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (diff.timedOut) throw new Error(`yrd: runtime source diff timed out after ${GIT_TIMEOUT_MS}ms`)
  if (diff.exitCode !== 0) {
    throw new Error(diff.stderr.trim() || `yrd: could not inspect loaded runtime source changes`)
  }
  if (diff.stdout !== "" || untrackedManifest.length > 0) {
    return `dirty:${createHash("sha256")
      .update(`${sha}\0${diff.stdout}\0${untrackedManifest.join("\0")}`)
      .digest("hex")}`
  }
  return sourceIdentity(sha)
}

/** Identity of the Yrd source authorized by one freshly fetched queue-base
 * commit. Comparing this with the startup-captured identity makes a root gitlink
 * advance observable even when a dirty shared checkout still contains old code. */
export async function authoritativeImplementationSource(
  process: Pick<Process, "run">,
  repository: string,
  authoritySha: string,
  sourceRepository?: ImplementationSourceRepository,
): Promise<string | undefined> {
  if (sourceRepository === undefined) return undefined
  const sourcePath =
    (await superprojectSourcePath(process, repository, sourceRepository)) ??
    relative(resolve(repository), resolve(sourceRepository.root))
  if (sourcePath === "" || sourcePath === ".") return sourceIdentity(authoritySha)
  if (sourcePath === ".." || sourcePath.startsWith(`..${sep}`)) {
    return implementationSourceIdentity(process, sourceRepository)
  }

  const gitPath = sourcePath.split(sep).join("/")
  const args = ["ls-tree", "--full-tree", authoritySha, "--", gitPath]
  const tree = await process.run({
    argv: ["git", "-C", repository, ...args],
    cwd: repository,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (tree.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  if (tree.exitCode !== 0) {
    throw new Error(tree.stderr.trim() || `yrd: could not inspect runtime source '${gitPath}' at '${authoritySha}'`)
  }
  const match = /^160000 commit ([0-9a-f]{40,64})\t/u.exec(tree.stdout.trim())
  if (match?.[1] === undefined) {
    throw new Error(`yrd: loaded runtime source '${gitPath}' is not a gitlink in authoritative base '${authoritySha}'`)
  }
  return sourceIdentity(match[1])
}
