import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"

const componentRoot = resolve(import.meta.dirname, "..")
const rootCommand =
  'cd "$(git rev-parse --show-superproject-working-tree --show-toplevel | head -1)" && bun run typecheck'
const topology = spawnSync("git", ["-C", componentRoot, "rev-parse", "--show-superproject-working-tree"], {
  encoding: "utf8",
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

const result = spawnSync("tsc", ["--noEmit", "-p", join(componentRoot, "tsconfig.hh.json")], {
  cwd: componentRoot,
  stdio: "inherit",
})
if (result.error !== undefined) {
  console.error(`yrd typecheck:hh: could not start tsc: ${result.error.message}`)
  process.exit(126)
}
process.exit(result.status ?? 1)
