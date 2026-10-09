/**
 * A temporary directory PROVEN to lie outside every Git repository (28434).
 *
 * `mkdtempSync(join(tmpdir(), …))` is outside a repository only when TMPDIR itself is. The yrd
 * service's own TMPDIR sits inside a developer checkout, and Git walks up from any fixture path
 * there, discovers the host repository, and answers the local read the fixture meant to make fail.
 * A fixture that assumes "outside" then exercises the host repository instead of the
 * no-repository case and quietly passes over the very defect it means to exercise.
 *
 * This helper does not trust TMPDIR. It builds a candidate under each base in turn and keeps the
 * first a local `git rev-parse --git-dir` proves is outside — the premise its callers assert — so
 * the directory is verified rather than assumed. Absence is proven ONLY by the expected diagnostic
 * ("not a git repository"): any other failure (a config parse error, a dubious-ownership refusal,
 * a killed process) leaves the premise UNPROVEN and is refused loudly, never certified as outside.
 * When no base yields a proven directory the helper refuses loudly, naming every base and why.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const DEFAULT_PREFIX = "yrd-outside-repository-"

/** Native Git's own diagnostic when it walks up and finds no repository from the directory. */
const NO_REPOSITORY = /not a git repository/u

/** Bases to try, in order, TMPDIR first so a healthy host keeps its fixtures where it put them. */
export function outsideRepositoryBases(): string[] {
  const seen = new Set<string>()
  const bases: string[] = []
  for (const candidate of [process.env.TMPDIR, tmpdir(), "/tmp", "/var/tmp"]) {
    if (candidate === undefined || candidate === "") continue
    const key = resolve(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    bases.push(candidate)
  }
  return bases
}

type Discovery =
  | Readonly<{ kind: "repository"; repository: string }>
  | Readonly<{ kind: "outside" }>
  | Readonly<{ kind: "unexpected"; detail: string }>

/** What native Git answers for `directory`: the repository it found, proven absence, or a failure. */
function discoveredRepository(directory: string): Discovery {
  const probe = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: directory, encoding: "utf8" })
  if (probe.error !== undefined) return { kind: "unexpected", detail: `could not run Git (${probe.error.message})` }
  if (probe.status === 0) {
    const repository = probe.stdout.trim()
    return { kind: "repository", repository: repository === "" ? "(a repository)" : repository }
  }
  if (NO_REPOSITORY.test(probe.stderr)) return { kind: "outside" }
  const ending = probe.status === null ? `was killed by ${String(probe.signal)}` : `exited ${String(probe.status)}`
  return { kind: "unexpected", detail: `git rev-parse --git-dir ${ending}: ${probe.stderr.trim()}` }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Attempt =
  | Readonly<{ kind: "outside"; directory: string }>
  | Readonly<{ kind: "refused"; reason: string; repository?: string }>

/** One candidate under `base`: its path when it is proven outside, else why it is not. */
function candidate(base: string, prefix: string): Attempt {
  let directory: string
  try {
    directory = mkdtempSync(join(base, prefix))
  } catch (error) {
    // Fail closed on creation: nothing was created, so this return reaches no removal below.
    return { kind: "refused", reason: `${base}: cannot create a temporary directory (${describe(error)})` }
  }
  const discovered = discoveredRepository(directory)
  if (discovered.kind === "outside") return { kind: "outside", directory }
  // raw-delete-allow: the empty directory this call just made with mkdtemp under base, refused because Git discovers a repository around it
  rmSync(directory, { recursive: true, force: true })
  if (discovered.kind === "repository") {
    return {
      kind: "refused",
      reason: `${base}: Git discovered ${discovered.repository}`,
      repository: discovered.repository,
    }
  }
  return { kind: "refused", reason: `${base}: ${discovered.detail}` }
}

let warnedAboutTmpdir = false

/**
 * Say once, loudly, that the ambient TMPDIR is inside a repository — the environmental fact that
 * made these fixtures lie (NO SILENT ERRORS). The fixture itself is already built elsewhere.
 */
function warnTmpdirInsideRepository(tmpdirCandidate: string | undefined, repository: string | undefined): void {
  if (warnedAboutTmpdir || tmpdirCandidate === undefined || repository === undefined) return
  warnedAboutTmpdir = true
  process.emitWarning(
    `yrd fixture: TMPDIR ${tmpdirCandidate} is inside the Git repository at ${repository}, so it is not outside any repository; the fixture is built elsewhere`,
    { code: "YRD_TMPDIR_INSIDE_REPOSITORY" },
  )
}

/** Throws unless `directory` is PROVEN outside every Git repository. */
export function assertOutsideRepository(directory: string): void {
  const discovered = discoveredRepository(directory)
  if (discovered.kind === "repository") {
    throw new Error(
      `yrd fixture: ${directory} is inside the Git repository at ${discovered.repository}, not outside any repository`,
    )
  }
  if (discovered.kind === "unexpected") {
    throw new Error(`yrd fixture: could not prove ${directory} is outside every Git repository: ${discovered.detail}`)
  }
}

/**
 * A fresh temporary directory proven outside every Git repository, created under the first usable
 * base. Callers own its removal, exactly as with `mkdtempSync`.
 */
export function outsideRepositoryRoot(
  prefix = DEFAULT_PREFIX,
  bases: readonly string[] = outsideRepositoryBases(),
): string {
  const tmpdirCandidate = process.env.TMPDIR
  const refused: string[] = []
  let tmpdirRepository: string | undefined
  for (const base of bases) {
    const attempt = candidate(base, prefix)
    if (attempt.kind === "outside") {
      warnTmpdirInsideRepository(tmpdirCandidate, tmpdirRepository)
      return attempt.directory
    }
    refused.push(attempt.reason)
    if (
      attempt.repository !== undefined &&
      tmpdirCandidate !== undefined &&
      resolve(base) === resolve(tmpdirCandidate)
    ) {
      tmpdirRepository = attempt.repository
    }
  }
  throw new Error(
    `yrd fixture: no directory outside every Git repository could be built; every base is inside one:\n${refused
      .map((line) => `  - ${line}`)
      .join("\n")}`,
  )
}
