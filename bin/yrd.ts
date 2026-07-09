#!/usr/bin/env bun
// yrd — the software delivery yard (staged identity for this repo; see
// docs/yrd.md). Projections are subcommands; `bay` is the only one installed
// today and it IS the git-bay CLI — same implementation, not a fork. Future
// projections (line, task, contest) arrive with the Yrd monorepo transition.
//
// Law 2 holds: quiet on success, meaningful exit codes. Unknown projection is
// an error (exit 2), bare `yrd`/help prints the yard usage (exit 0).

const USAGE = `yrd — the software delivery yard

USAGE
  yrd bay <verb> [args]   the Git-native bay (same implementation as \`git bay\`)

Installed projections: bay
Staged (not yet installed): line, task, contest — see docs/yrd.md
`

const projection = process.argv[2]

if (projection === undefined || projection === "--help" || projection === "-h" || projection === "help") {
  console.log(USAGE)
  process.exit(0)
}

if (projection !== "bay") {
  console.error(`yrd: unknown projection '${projection}' (installed: bay)`)
  process.exit(2)
}

// Re-enter the git-bay CLI with `bay` spliced out so `yrd bay submit` parses
// exactly like `git bay submit`. Dynamic import so the argv rewrite happens
// BEFORE the CLI reads process.argv (static imports would hoist above it).
process.argv = [process.argv[0] ?? "bun", process.argv[1] ?? "yrd", ...process.argv.slice(3)]
await import("./git-bay.ts")

export {}
