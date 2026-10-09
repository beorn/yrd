import { cleanGitEnvironment, gitFailure } from "@yrd/process"
import { accessSync, constants, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import pkg from "../package.json" with { type: "json" }

const GIT_TIMEOUT_MS = 5_000
const DISTRIBUTION_PACKAGE_NAME = "git-yrd"

export function yrdSourceRoot(start = import.meta.dirname): string | undefined {
  let directory = start
  for (;;) {
    try {
      const candidate = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown }
      if (candidate.name === DISTRIBUTION_PACKAGE_NAME) return directory
    } catch {
      // silent-fallback-allow: version diagnostics walk through directories
      // that normally have no package.json. Failure to find the owning package
      // returns `unknown`; it must never fall through to a parent Git repo.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export function readDistributionVersion(sourceRoot = yrdSourceRoot()): string {
  if (sourceRoot !== undefined) {
    try {
      const candidate = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")) as { version?: unknown }
      if (typeof candidate.version === "string") return candidate.version
    } catch {
      // silent-fallback-allow: malformed or unreadable distribution package.json
      // falls back to the embedded package version.
    }
  }
  return pkg.version
}

/** The git-yrd distribution version, read from the distribution package.json or embedded package fallback. */
export const YRD_VERSION = readDistributionVersion()

function sourceGit(args: readonly string[]): { status: number; stdout: string } {
  // `git yrd` may inherit GIT_DIR/GIT_WORK_TREE/GIT_PREFIX from its caller.
  // Those describe the operated-on repository, not the Yrd code that is
  // running. Scrub the whole Git environment and anchor both cwd and -C to the
  // loaded Yrd checkout so the reported identity cannot cross repositories.
  const root = yrdSourceRoot()
  if (root === undefined) return { status: 1, stdout: "" }
  try {
    accessSync(join(root, ".git"), constants.F_OK)
  } catch {
    // An installed package nested under a consumer repository must never
    // inherit the consumer's HEAD as Yrd's runtime identity.
    return { status: 1, stdout: "" }
  }
  const [verb, ...rest] = args
  if (verb !== "rev-parse" && verb !== "status") throw new Error(`yrd: unsupported source Git read '${verb ?? ""}'`)
  const spawned = Bun.spawnSync(["git", "-C", root, verb, ...rest], {
    // Let `git -C` report a missing/non-repository target as a normal Git exit.
    // Anchoring the OS spawn there turns that domain result into an unrelated
    // ENOENT before Git can run.
    cwd: process.cwd(),
    env: { ...cleanGitEnvironment(process.env), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", TZ: "UTC" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
  })
  const decode = (output: Uint8Array | undefined): string =>
    output === undefined ? "" : new TextDecoder().decode(output)
  const signal = spawned.signalCode == null ? null : String(spawned.signalCode)
  const timedOut = spawned.exitedDueToTimeout === true
  const failure = timedOut
    ? "source git read timed out"
    : signal === null
      ? undefined
      : `source git read ended on ${signal}`
  const result = {
    code: typeof spawned.exitCode === "number" ? spawned.exitCode : 1,
    stdout: decode(spawned.stdout),
    stderr: decode(spawned.stderr),
    signal,
    timedOut,
    ...(failure === undefined ? {} : { failure }),
  }
  if (failure !== undefined) {
    throw new Error(`yrd: git ${args.join(" ")} ${gitFailure(result, GIT_TIMEOUT_MS)}`)
  }
  return { status: result.code, stdout: result.stdout }
}

/** Runtime identity for every Yrd CLI projection, anchored to Yrd source. */
export function formatYrdRuntimeVersion(git: typeof sourceGit = sourceGit): string {
  const head = git(["rev-parse", "--short=10", "--verify", "HEAD"])
  const status = git(["status", "--porcelain=v1"])
  const sha = head.stdout.trim()
  if (head.status !== 0 || !/^[0-9a-f]{10}$/iu.test(sha) || status.status !== 0) {
    return `yrd ${YRD_VERSION}+unknown`
  }
  const dirty = status.stdout.trim() !== ""
  return `yrd ${YRD_VERSION}+${sha}${dirty ? "-dirty" : ""}`
}

/**
 * Submit / env open / env close: an unknown top-level key is a loud warning, not a
 * refusal (26121). Name the key, this reader's version, and the cure.
 */
export function formatUnknownTopLevelKeyWarning(at: string, command: string, keys: readonly string[]): string {
  const one = keys.length === 1
  return (
    `yrd: the declaration at ${at} has ${one ? "a key" : "keys"} this environment's Yrd does not know: ` +
    `${keys.map((key) => `${key}:`).join(", ")} (${formatYrdRuntimeVersion()}). ` +
    `The queue runs ${one ? "it" : "them"}; ${command} does not, so it proceeds without ${one ? "it" : "them"}. ` +
    `Run with main's yrd to apply it.\n`
  )
}
