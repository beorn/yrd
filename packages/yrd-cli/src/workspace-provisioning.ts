import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Process, ProcessResult } from "@yrd/process"

const PACKAGE_MANAGERS = [
  { lockfile: "bun.lock", manager: "bun", install: ["install", "--frozen-lockfile", "--ignore-scripts"] },
  { lockfile: "bun.lockb", manager: "bun", install: ["install", "--frozen-lockfile", "--ignore-scripts"] },
  { lockfile: "pnpm-lock.yaml", manager: "pnpm", install: ["install", "--frozen-lockfile", "--ignore-scripts"] },
  { lockfile: "package-lock.json", manager: "npm", install: ["ci", "--ignore-scripts"] },
] as const satisfies readonly Readonly<{ lockfile: string; manager: string; install: readonly string[] }>[]

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

type WorkspaceDependencyOptions = Readonly<{
  path: string
  subject: string
  manifestSubject?: string
  runPostinstall?: boolean
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  onCommand?: (argv: readonly string[]) => void
  writeOutput?: (text: string) => void
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

  const provision = async (argv: readonly string[]): Promise<void> => {
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
      options.fail(
        `${options.subject} could not install its dependencies in ${options.path}; ` +
          `${argv.join(" ")} could not start: ${errorDetail(error)}`,
      )
    }
    const tail = decoder.decode()
    if (tail !== "") options.writeOutput?.(tail)
    if (childSucceeded(result)) return
    // The DIRECTORY is the half of the diagnosis the tail never carries. An
    // install failing on `@silvery/theme@workspace:*` says the workspace globs
    // matched nothing; only the path says WHICH checkout was in that state, and
    // it is right here in options. Without it an operator hunts through every
    // Bay looking for the cold one (@yrd/submit-check-workspace-cannot-install).
    options.fail(
      `${options.subject} could not install its dependencies in ${options.path}; ` +
        `${argv.join(" ")} ${childFailureReason(result)}\n${commandOutputTail(result)}`,
    )
  }

  await provision([chosen.manager, ...chosen.install])
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
