import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cleanGitEnvironment, type Process } from "@yrd/process"
import { GIT_PLUMBING_TIMEOUT_MS as GIT_TIMEOUT_MS } from "./git-timeouts.ts"
import { yrdSourceRoot } from "./version.ts"

export const YRD_WRAPPER_IMPLEMENTATION_SOURCE_ENV = "YRD_WRAPPER_IMPLEMENTATION_SOURCE"

export type ImplementationSourceRepository = Readonly<{
  root: string
}>

/**
 * Consume the one-process attestation installed by a trusted launcher.
 *
 * Git-owned source checkouts remain the default. A launcher may provide the
 * same operator-visible identity when the runtime itself is not a Git checkout.
 */
export function takeImplementationSourceAttestation(env: NodeJS.ProcessEnv): string | undefined {
  const identity = env[YRD_WRAPPER_IMPLEMENTATION_SOURCE_ENV]?.trim()
  delete env[YRD_WRAPPER_IMPLEMENTATION_SOURCE_ENV]
  if (identity === undefined) return undefined
  if (!/^(?:dirty|git):[0-9a-f]{40,64}$/u.test(identity)) {
    throw new Error("yrd: installed implementation-source identity is invalid")
  }
  return identity
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

/** Identity of the Yrd source checkout at process startup, preserved for
 * operator-visible runner status only. Launch policy—not queue admission—owns
 * whether that source may change while the process is alive. */
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
