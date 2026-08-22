import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Process, ProcessResult } from "@yrd/process"

/**
 * `install` is the default and stays frozen: a lockfile is a committed
 * decision, and an install that silently resolves something else makes every
 * downstream check a measurement of a tree nobody reviewed.
 *
 * `relaxed` is reachable ONLY through an explicit
 * {@link WorkspaceDependencyOptions.lockfileRegeneration} authorization AND a
 * `staleLockfile` match on the frozen refusal's own output. `staleLockfile`
 * is the manager's verbatim "your lockfile no longer matches the manifests"
 * refusal — never a generic failure — so a broken registry, a cold cache or a
 * missing manager can never be mistaken for a stale lockfile and retried.
 */
const PACKAGE_MANAGERS = [
  {
    lockfile: "bun.lock",
    manager: "bun",
    install: ["install", "--frozen-lockfile", "--ignore-scripts"],
    // Relaxing bun means OMITTING the freeze flag, not negating it: 1.3.14
    // documents no --no-frozen-lockfile counterpart to pnpm's below. A bare
    // install also stays unfrozen under CI=true (verified on 1.3.14), which is
    // the load-bearing half — a manager that self-freezes in CI would make this
    // retry a silent no-op that refuses identically to the frozen attempt.
    relaxed: ["install", "--ignore-scripts"],
    staleLockfile: /lockfile had changes, but lockfile is frozen/iu,
  },
  {
    lockfile: "bun.lockb",
    manager: "bun",
    install: ["install", "--frozen-lockfile", "--ignore-scripts"],
    relaxed: ["install", "--ignore-scripts"],
    staleLockfile: /lockfile had changes, but lockfile is frozen/iu,
  },
  {
    lockfile: "pnpm-lock.yaml",
    manager: "pnpm",
    install: ["install", "--frozen-lockfile", "--ignore-scripts"],
    relaxed: ["install", "--no-frozen-lockfile", "--ignore-scripts"],
    staleLockfile: /ERR_PNPM_OUTDATED_LOCKFILE|cannot install with "frozen-lockfile"/iu,
  },
  {
    lockfile: "package-lock.json",
    manager: "npm",
    install: ["ci", "--ignore-scripts"],
    relaxed: ["install", "--ignore-scripts"],
    staleLockfile: /can only install packages when your package\.json and package-lock\.json/iu,
  },
] as const satisfies readonly Readonly<{
  lockfile: string
  manager: string
  install: readonly string[]
  relaxed: readonly string[]
  staleLockfile: RegExp
}>[]

/** A dependency install prepares an execution environment; it gets a generous
 * lease so a cold package cache is not mistaken for a wedged check. */
const PROVISION_TIMEOUT_MS = 900_000
const PROVISION_COMPLETE_MARKER = ".yrd-provision-complete"

type ManifestProvisioning = Readonly<{
  hasDependencies: boolean
  hasPostinstall: boolean
}>

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The bytes of a lockfile at one instant, identified so a reader can prove
 * the regeneration actually changed something rather than trusting the claim. */
export type LockfileState = Readonly<{ bytes: number; sha256: string }>

/** What a relaxed install did, disclosed as evidence. A regenerated lockfile
 * is a tree nobody committed, so the run has to be able to say precisely which
 * submodule manifests forced it and what the resulting lockfile is. */
export type LockfileRegenerationEvidence = Readonly<{
  path: string
  manager: string
  lockfile: string
  /** The frozen refusal, verbatim, that authorized the relaxed retry. */
  frozenRefusal: string
  /** Manifest paths, submodule-qualified, that differ between base and candidate. */
  changedSubmoduleManifests: readonly string[]
  before: LockfileState
  after: LockfileState
  /** False means the frozen install refused but the relaxed install wrote the
   * same bytes back — a contradiction the reader must see rather than a fact
   * the provisioner may quietly absorb. */
  lockfileChanged: boolean
}>

/**
 * Authorization to regenerate a stale lockfile in place, and the sink that
 * discloses it. Absent, `--frozen-lockfile` is absolute — which is what keeps
 * "a human forgot to commit their lockfile" a refusal.
 */
export type LockfileRegenerationPolicy = Readonly<{
  /** The manifests whose movement explains the staleness; empty withholds
   * authorization. Resolved ONLY after a stale-lockfile refusal, so the git
   * reads behind it never cost — or endanger — a candidate that installs
   * cleanly. */
  changedSubmoduleManifests(): Promise<readonly string[]>
  record(evidence: LockfileRegenerationEvidence): void | Promise<void>
}>

type WorkspaceDependencyOptions = Readonly<{
  path: string
  subject: string
  manifestSubject?: string
  runPostinstall?: boolean
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  onCommand?: (argv: readonly string[]) => void
  writeOutput?: (text: string) => void
  lockfileRegeneration?: LockfileRegenerationPolicy
  fail(message: string): never
}>

function manifestProvisioning(
  manifest: string,
  path: string,
  subject: string,
  fail: WorkspaceDependencyOptions["fail"],
): ManifestProvisioning {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest)
  } catch (error) {
    fail(`${subject} manifest '${path}' is not valid JSON: ${errorDetail(error)}`)
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { hasDependencies: false, hasPostinstall: false }
  }
  const manifestObject = parsed as Record<string, unknown>
  const hasDependencies = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(
    (field) => {
      const dependencies = manifestObject[field]
      return typeof dependencies === "object" && dependencies !== null && Object.keys(dependencies).length > 0
    },
  )
  const scripts = (parsed as { scripts?: unknown }).scripts
  if (typeof scripts !== "object" || scripts === null) {
    return { hasDependencies, hasPostinstall: false }
  }
  const postinstall = (scripts as { postinstall?: unknown }).postinstall
  return {
    hasDependencies,
    hasPostinstall: typeof postinstall === "string" && postinstall.trim() !== "",
  }
}

function childSucceeded(child: ProcessResult): boolean {
  return (
    child.exitCode === 0 &&
    child.signal === null &&
    !child.timedOut &&
    child.stalled !== true &&
    child.sweepFailure === undefined &&
    child.escapedDescendant !== true
  )
}

function childFailureReason(result: ProcessResult): string {
  if (result.timedOut) return "child timed out"
  if (result.escapedDescendant === true) return "child exited with an escaped descendant"
  if (result.stalled === true) return "child stalled"
  if (result.signal !== null) return `child exited after ${result.signal}`
  if (result.sweepFailure !== undefined) return `child cleanup failed: ${result.sweepFailure}`
  return `child exited ${result.exitCode}`
}

function commandOutputTail(result: ProcessResult, limit = 600): string {
  const output = `${result.stdout}\n${result.stderr}`.trim()
  return output.length <= limit ? output : `…${output.slice(-limit)}`
}

type InstallAttempt =
  | Readonly<{ status: "succeeded" }>
  | Readonly<{ status: "failed"; message: string; output: string }>

type PackageManager = (typeof PACKAGE_MANAGERS)[number]

async function lockfileState(path: string, lockfile: string): Promise<LockfileState | undefined> {
  try {
    const bytes = await readFile(join(path, lockfile))
    return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

/**
 * Run the dependency install, and cure a stale lockfile only where a stale
 * lockfile is genuinely uncurable upstream.
 *
 * A submodule pin advance that changes that submodule's dependency SPECS makes
 * the superproject's lockfile stale the instant the pin lands, and the cure
 * cannot be staged ahead of it: gitlinks land alone, so a lockfile committed
 * first is refused against the old pin, and one committed after is refused
 * against the new one. Frozen therefore deadlocks that intent forever. The
 * escape is narrow on purpose — an explicit authorization naming the drifted
 * manifests, AND the manager's own stale-lockfile refusal — so the ordinary
 * "someone forgot to commit their lockfile" case keeps refusing.
 */
async function install(
  chosen: PackageManager,
  attempt: (argv: readonly string[]) => Promise<InstallAttempt>,
  options: WorkspaceDependencyOptions,
): Promise<void> {
  const frozen = await attempt([chosen.manager, ...chosen.install])
  if (frozen.status === "succeeded") return

  const regeneration = options.lockfileRegeneration
  // Unauthorized, or a failure that is not a stale lockfile at all: this is
  // today's refusal, unchanged and verbatim. Never widen it — a cold cache and
  // a stale lockfile look alike only until you read the manager's own words.
  if (regeneration === undefined || !chosen.staleLockfile.test(frozen.output)) options.fail(frozen.message)

  const manifests = await regeneration.changedSubmoduleManifests()
  if (manifests.length === 0) {
    options.fail(
      `${options.subject} found '${chosen.lockfile}' stale in ${options.path}, but no changed submodule manifest ` +
        `explains it; --frozen-lockfile stands. Commit the regenerated lockfile with the change that made it ` +
        `stale.\n${frozen.message}`,
    )
  }

  const before = await lockfileState(options.path, chosen.lockfile)
  if (before === undefined) {
    options.fail(
      `${options.subject} could not read '${chosen.lockfile}' in ${options.path} before regenerating it; ` +
        `the frozen install refused against a lockfile that is no longer readable\n${frozen.message}`,
    )
  }

  const relaxed = await attempt([chosen.manager, ...chosen.relaxed])
  if (relaxed.status === "failed") {
    // Both doors are shut. Say so as one diagnosis: the operator needs the
    // frozen refusal (why we retried), the relaxed refusal (why the cure
    // failed) and the manifests (what made it necessary) in one place.
    options.fail(
      `${relaxed.message}\n` +
        `this was the fallback after --frozen-lockfile refused a stale lockfile caused by changed submodule ` +
        `manifests [${manifests.join(", ")}]; regenerating '${chosen.lockfile}' failed too, so the candidate ` +
        `cannot be provisioned either way\n${frozen.message}`,
    )
  }

  const after = await lockfileState(options.path, chosen.lockfile)
  if (after === undefined) {
    options.fail(
      `${options.subject} regenerated dependencies in ${options.path} but '${chosen.lockfile}' is missing ` +
        `afterwards; ${chosen.manager} reported success without leaving a lockfile behind`,
    )
  }

  await regeneration.record({
    path: options.path,
    manager: chosen.manager,
    lockfile: chosen.lockfile,
    frozenRefusal: frozen.output.trim(),
    changedSubmoduleManifests: manifests,
    before,
    after,
    lockfileChanged: before.sha256 !== after.sha256,
  })
}

/**
 * Make an isolated workspace runnable before its owner launches a child.
 *
 * Git worktrees carry tracked files but no ignored dependency tree. The
 * repository's committed lockfile selects the package manager; Yrd never
 * guesses. Lifecycle scripts stay disabled unless an owner-controlled caller
 * explicitly opts into the repository's postinstall.
 */
export async function ensureWorkspaceDependencies(
  processService: Pick<Process, "run">,
  options: WorkspaceDependencyOptions,
): Promise<void> {
  const manifestPath = join(options.path, "package.json")
  if (!existsSync(manifestPath)) return
  const dependencyPath = join(options.path, "node_modules")
  const completionMarker = join(dependencyPath, PROVISION_COMPLETE_MARKER)
  if (existsSync(completionMarker)) return
  let manifestSource: string
  try {
    manifestSource = await readFile(manifestPath, "utf8")
  } catch (error) {
    options.fail(`${options.subject} could not read its manifest '${manifestPath}': ${errorDetail(error)}`)
  }
  const manifest = manifestProvisioning(
    manifestSource,
    manifestPath,
    options.manifestSubject ?? options.subject,
    options.fail,
  )
  const chosen = PACKAGE_MANAGERS.find((candidate) => existsSync(join(options.path, candidate.lockfile)))
  if (chosen === undefined) {
    if (!manifest.hasDependencies && !manifest.hasPostinstall) return
    options.fail(
      `${options.subject} requires provisioning but has no recognized package-manager lockfile; expected one of ` +
        PACKAGE_MANAGERS.map((candidate) => candidate.lockfile).join(", "),
    )
  }

  // A failed install is not automatically fatal any more: a stale-lockfile
  // refusal may be curable. `attempt` therefore REPORTS the failure — with the
  // message today's caller would have died on, plus the untruncated output the
  // stale-lockfile signature is matched against — and leaves the verdict to the
  // one caller that has the authorization to relax.
  const attempt = async (argv: readonly string[]): Promise<InstallAttempt> => {
    options.onCommand?.(argv)
    const decoder = new TextDecoder()
    let result: ProcessResult
    try {
      result = await processService.run({
        argv,
        cwd: options.path,
        ...(options.env === undefined ? {} : { env: options.env }),
        timeoutMs: PROVISION_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.writeOutput === undefined
          ? {}
          : {
              onOutput({ chunk }) {
                const text = decoder.decode(chunk, { stream: true })
                if (text !== "") options.writeOutput?.(text)
              },
            }),
      })
    } catch (error) {
      // A manager that never started produced no output, so it can never match
      // a stale-lockfile signature — exactly right, that is not what happened.
      return {
        status: "failed",
        output: "",
        message:
          `${options.subject} could not install its dependencies in ${options.path}; ` +
          `${argv.join(" ")} could not start: ${errorDetail(error)}`,
      }
    }
    const tail = decoder.decode()
    if (tail !== "") options.writeOutput?.(tail)
    if (childSucceeded(result)) return { status: "succeeded" }
    // The DIRECTORY is the half of the diagnosis the tail never carries. An
    // install failing on `@silvery/theme@workspace:*` says the workspace globs
    // matched nothing; only the path says WHICH checkout was in that state, and
    // it is right here in options. Without it an operator hunts through every
    // Bay looking for the cold one (@yrd/submit-check-workspace-cannot-install).
    return {
      status: "failed",
      output: `${result.stdout}\n${result.stderr}`,
      message:
        `${options.subject} could not install its dependencies in ${options.path}; ` +
        `${argv.join(" ")} ${childFailureReason(result)}\n${commandOutputTail(result)}`,
    }
  }

  const provision = async (argv: readonly string[]): Promise<void> => {
    const outcome = await attempt(argv)
    if (outcome.status === "failed") options.fail(outcome.message)
  }

  await install(chosen, attempt, options)
  if (manifest.hasPostinstall && options.runPostinstall === true) {
    await provision([chosen.manager, "run", "postinstall"])
  }
  try {
    await mkdir(dependencyPath, { recursive: true })
    await writeFile(completionMarker, "complete\n")
  } catch (error) {
    options.fail(`${options.subject} could not record completed dependency provisioning: ${errorDetail(error)}`)
  }
}
