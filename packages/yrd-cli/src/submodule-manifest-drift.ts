import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Process } from "@yrd/process"

/** Git reports an absent side of a gitlink change as an all-zero id. */
const ABSENT_PIN = /^0+$/u
const DEPENDENCY_SPEC_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const
const GITLINK_MODE = "160000"
const MANIFEST = "package.json"

/** A git read that answers an authorization question gets a short lease: it
 * reads local objects only, so a slow one is a broken repository, not work. */
const GIT_TIMEOUT_MS = 60_000

export type SubmoduleManifestDrift = Readonly<{
  /** Path of the submodule inside the superproject. */
  submodule: string
  basePin: string
  candidatePin: string
  /** Superproject-relative manifests whose dependency specs moved, or which were added/removed. */
  manifests: readonly string[]
}>

type Options = Readonly<{
  /** Superproject holding BOTH commits; the gitlink diff is read here. */
  repo: string
  /** Materialized candidate checkout whose submodule working directories hold
   * the objects for both pins. */
  workspace: string
  baseSha: string
  candidateSha: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  fail(message: string): never
}>

type GitlinkChange = Readonly<{ submodule: string; basePin: string; candidatePin: string }>

async function git(
  processService: Pick<Process, "run">,
  options: Options,
  cwd: string,
  argv: readonly string[],
): Promise<string> {
  const result = await processService.run({
    argv: ["git", ...argv],
    cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (result.exitCode !== 0 || result.timedOut) {
    const detail = (result.stderr || result.stdout || "no output").trim()
    options.fail(
      `could not read submodule manifest drift: 'git ${argv.join(" ")}' in ${cwd} ` +
        `${result.timedOut ? `timed out after ${GIT_TIMEOUT_MS}ms` : `exited ${result.exitCode}`}: ${detail}`,
    )
  }
  return result.stdout
}

/** Parse `git diff --raw -z`, keeping only entries where either side is a gitlink. */
function gitlinkChanges(raw: string, options: Options): readonly GitlinkChange[] {
  const fields = raw.split("\0").filter((field) => field !== "")
  const changes: GitlinkChange[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const meta = fields[index]
    if (meta === undefined || !meta.startsWith(":")) continue
    const [baseMode, candidateMode, basePin, candidatePin, status] = meta.slice(1).split(" ")
    const path = fields[index + 1]
    index += 1
    if (
      baseMode === undefined ||
      candidateMode === undefined ||
      basePin === undefined ||
      candidatePin === undefined ||
      status === undefined ||
      path === undefined
    ) {
      options.fail(`could not read submodule manifest drift: unparsable 'git diff --raw' record '${meta}'`)
    }
    // A rename or copy carries a second path field; --no-renames is passed so
    // seeing one means the reader and the command disagree, never a fact to skip.
    if (status.startsWith("R") || status.startsWith("C")) {
      options.fail(
        `could not read submodule manifest drift: 'git diff --raw --no-renames' still reported ` +
          `status '${status}' for '${path}'`,
      )
    }
    if (baseMode !== GITLINK_MODE && candidateMode !== GITLINK_MODE) continue
    changes.push({ submodule: path, basePin, candidatePin })
  }
  return changes
}

/** Map every tracked `package.json` in a pin to its blob id. Blob identity lets
 * the semantic comparison avoid reading manifests that are byte-for-byte equal. */
async function manifestBlobs(
  processService: Pick<Process, "run">,
  options: Options,
  submoduleWorkdir: string,
  pin: string,
): Promise<ReadonlyMap<string, string>> {
  if (ABSENT_PIN.test(pin)) return new Map()
  const listing = await git(processService, options, submoduleWorkdir, ["ls-tree", "-r", "-z", pin])
  const blobs = new Map<string, string>()
  for (const entry of listing.split("\0")) {
    if (entry === "") continue
    const separator = entry.indexOf("\t")
    if (separator === -1) {
      options.fail(`could not read submodule manifest drift: unparsable 'git ls-tree' record '${entry}'`)
    }
    const [, type, blob] = entry.slice(0, separator).split(/\s+/u)
    const path = entry.slice(separator + 1)
    if (type !== "blob" || blob === undefined) continue
    if (path === MANIFEST || path.endsWith(`/${MANIFEST}`)) blobs.set(path, blob)
  }
  return blobs
}

function dependencySpecs(manifest: string, subject: string, options: Options): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest)
  } catch (error) {
    options.fail(
      `could not read submodule manifest drift: ${subject} is not valid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    options.fail(`could not read submodule manifest drift: ${subject} is not a JSON object`)
  }

  const record = parsed as Record<string, unknown>
  const specs: Record<string, Record<string, unknown>> = {}
  for (const field of DEPENDENCY_SPEC_FIELDS) {
    const value = record[field]
    if (value === undefined) {
      specs[field] = {}
      continue
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      options.fail(`could not read submodule manifest drift: ${subject} field '${field}' is not an object`)
    }
    specs[field] = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
    )
  }
  return JSON.stringify(specs)
}

async function manifestDependencySpecs(
  processService: Pick<Process, "run">,
  options: Options,
  submoduleWorkdir: string,
  pin: string,
  path: string,
): Promise<string> {
  const manifest = await git(processService, options, submoduleWorkdir, ["show", `${pin}:${path}`])
  return dependencySpecs(manifest, `'${path}' at ${pin}`, options)
}

/**
 * Which submodule manifests moved between the base and the candidate.
 *
 * This is the authorization question behind relaxing `--frozen-lockfile`: a
 * superproject lockfile is stale *and uncurable ahead of time* exactly when a
 * gitlink advance changes the dependency specs inside that submodule, because
 * gitlinks merge alone. Every other staleness — a hand-edited manifest, a
 * forgotten lockfile commit — must keep refusing, so an unreadable pin is a
 * loud refusal here and never an assumption of drift.
 */
export async function submoduleManifestDrift(
  processService: Pick<Process, "run">,
  options: Options,
): Promise<readonly SubmoduleManifestDrift[]> {
  const raw = await git(processService, options, options.repo, [
    "diff",
    "--raw",
    "--no-renames",
    "-z",
    options.baseSha,
    options.candidateSha,
  ])
  const drifts: SubmoduleManifestDrift[] = []
  for (const change of gitlinkChanges(raw, options)) {
    // A DELETION has no candidate side to compare: the submodule is leaving, so its
    // manifests cannot drift against anything. Discriminate on the NULL PIN and never
    // on materialization failure — the docblock above requires an unreadable pin to
    // stay a loud refusal, and skipping on a missing workdir would hide a genuinely
    // broken checkout. The null pin comes from the diff itself, needs no filesystem
    // access, and cannot be produced by a broken checkout.
    if (/^0+$/u.test(change.candidatePin)) continue
    const submoduleWorkdir = join(options.workspace, change.submodule)
    if (!existsSync(join(submoduleWorkdir, ".git"))) {
      options.fail(
        `could not read submodule manifest drift: submodule '${change.submodule}' is not materialized at ` +
          `${submoduleWorkdir}, so its manifests at ${change.basePin} and ${change.candidatePin} cannot be compared`,
      )
    }
    const base = await manifestBlobs(processService, options, submoduleWorkdir, change.basePin)
    const candidate = await manifestBlobs(processService, options, submoduleWorkdir, change.candidatePin)
    const manifests: string[] = []
    for (const path of [...new Set([...base.keys(), ...candidate.keys()])].sort()) {
      const baseBlob = base.get(path)
      const candidateBlob = candidate.get(path)
      if (baseBlob === candidateBlob) continue
      // A manifest appearing or disappearing changes workspace membership even
      // when it has no dependencies, so it remains lockfile-relevant.
      if (baseBlob === undefined || candidateBlob === undefined) {
        manifests.push(path)
        continue
      }
      const [baseSpecs, candidateSpecs] = await Promise.all([
        manifestDependencySpecs(processService, options, submoduleWorkdir, change.basePin, path),
        manifestDependencySpecs(processService, options, submoduleWorkdir, change.candidatePin, path),
      ])
      if (baseSpecs !== candidateSpecs) manifests.push(path)
    }
    if (manifests.length === 0) continue
    drifts.push({
      submodule: change.submodule,
      basePin: change.basePin,
      candidatePin: change.candidatePin,
      manifests: manifests.map((path) => `${change.submodule}/${path}`),
    })
  }
  return drifts
}
