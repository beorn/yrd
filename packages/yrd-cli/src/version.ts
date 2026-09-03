import { cleanGitEnvironment, gitFailure } from "@yrd/process"
import { accessSync, constants, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import distribution from "../../../package.json" with { type: "json" }

/** The git-yrd distribution version, embedded by the production bundle. */
export const YRD_VERSION = distribution.version
const GIT_TIMEOUT_MS = 5_000

export function yrdSourceRoot(start = import.meta.dirname): string | undefined {
  let directory = start
  for (;;) {
    try {
      const candidate = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown }
      if (candidate.name === distribution.name) return directory
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
  const failure = timedOut ? "source git read timed out" : signal === null ? undefined : `source git read ended on ${signal}`
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
