import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { cleanGitEnvironment } from "@yrd/process"

const submoduleRoot = resolve(import.meta.dirname, "..")
const rootCommand =
  'cd "$(git rev-parse --show-superproject-working-tree --show-toplevel | head -1)" && bun run typecheck'
// yrd's one scrubber: a leaked GIT_DIR (a git hook's) must not answer for another repository (hh 26003).
const topology = spawnSync("git", ["-C", submoduleRoot, "rev-parse", "--show-superproject-working-tree"], {
  encoding: "utf8",
  env: cleanGitEnvironment(process.env),
})
const superprojectRoot = topology.status === 0 ? topology.stdout.trim() : ""

if (superprojectRoot === "") {
  console.error("yrd typecheck:hh: unsupported standalone topology; this check requires the hh superproject")
  console.error(`authoritative hh-root check: ${rootCommand}`)
  console.error("standalone Yrd check: bun run typecheck")
  process.exit(2)
}

if (process.argv.includes("--probe")) {
  console.log(`yrd typecheck:hh: hh superproject at ${superprojectRoot}`)
  process.exit(0)
}

const result = spawnSync("bun", ["run", "typecheck"], {
  cwd: superprojectRoot,
  stdio: "inherit",
})
if (result.error !== undefined) {
  console.error(`yrd typecheck:hh: could not start hh-root typecheck: ${result.error.message}`)
  process.exit(126)
}
process.exit(result.status ?? 1)
