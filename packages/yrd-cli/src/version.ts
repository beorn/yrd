import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import distribution from "../../../package.json" with { type: "json" }

/** The git-yrd distribution version, embedded by the production bundle. */
export const YRD_VERSION = distribution.version

function yrdSourceRoot(): string | undefined {
  let directory = import.meta.dirname
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
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]
  const root = yrdSourceRoot()
  if (root === undefined) return { status: 1, stdout: "" }
  const result = spawnSync("git", ["-C", root, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? "" }
}

/** Runtime identity for every Yrd CLI projection, anchored to Yrd source. */
export function formatYrdRuntimeVersion(): string {
  const head = sourceGit(["rev-parse", "--short=10", "--verify", "HEAD"])
  const sha = head.status === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : "unknown"
  const status = sourceGit(["status", "--porcelain=v1"])
  const dirty = status.status === 0 && status.stdout.trim() !== ""
  return `yrd ${YRD_VERSION}+${sha}${dirty ? "-dirty" : ""}`
}
