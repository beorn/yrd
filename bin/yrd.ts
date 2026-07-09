#!/usr/bin/env bun
// yrd — the software delivery yard (staged identity for this repo; see
// docs/yrd.md). Projections are subcommands; `bay` and `line` are installed
// today. `bay` IS the git-bay CLI — same implementation, not a fork. `line`
// projects onto the same check/merge/integrate machinery and journal events.
// Future projections (task, contest) arrive with the Yrd monorepo transition.
//
// Law 2 holds: quiet on success, meaningful exit codes. Unknown projection is
// an error (exit 2), bare `yrd`/help prints the yard usage (exit 0).

const USAGE = `yrd — the software delivery yard

USAGE
  yrd bay <verb> [args]   the Git-native bay (same implementation as \`git bay\`)
  yrd line <verb> [args]  integration line projection over the same bay state

Installed projections: bay, line
Staged (not yet installed): task, contest — see docs/yrd.md
`

const LINE_USAGE = `yrd line — integration line projection

USAGE
  yrd line status [PR|name] [--json]
  yrd line audit [--json]
  yrd line integrate [PR|name] [--steps check,merge] [--retry] [--watch] [--interval <sec>]
  yrd line watch [PR|name] [--interval <sec>]

Installed steps: check, merge
Staged steps: deploy
`

const projection = process.argv[2]

async function reenterGitBay(args: string[]): Promise<void> {
  // Dynamic import so argv rewriting happens BEFORE the CLI reads process.argv
  // (static imports would hoist above it).
  process.argv = [process.argv[0] ?? "bun", process.argv[1] ?? "yrd", ...args]
  await import("./git-bay.ts")
}

function printUsage(): void {
  console.log(USAGE)
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

function parseSteps(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return ["check", "merge"]
  const steps = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (steps.length === 0) return ["check", "merge"]
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step)) fail(`yrd: line integrate: duplicate step '${step}'`)
    seen.add(step)
    if (step === "deploy") {
      fail("yrd: line integrate: step 'deploy' is staged, not installed yet (installed: check, merge)")
    }
    if (step !== "check" && step !== "merge") {
      fail(`yrd: line integrate: unknown step '${step}' (installed: check, merge; staged: deploy)`)
    }
  }
  return steps
}

type ParsedIntegrate = {
  target?: string
  steps: string[]
  retry: boolean
  passthrough: string[]
}

function parseIntegrateArgs(args: string[]): ParsedIntegrate {
  let target: string | undefined
  let stepsRaw: string | undefined
  let retry = false
  const passthrough: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--steps") {
      const value = args[++i]
      if (value === undefined) fail("yrd: line integrate: --steps requires a comma-separated value")
      stepsRaw = value
      continue
    }
    if (arg.startsWith("--steps=")) {
      stepsRaw = arg.slice("--steps=".length)
      continue
    }
    if (arg === "--retry") {
      retry = true
      continue
    }
    if (arg === "--watch") {
      passthrough.push(arg)
      continue
    }
    if (arg === "--interval") {
      const value = args[++i]
      if (value === undefined) fail("yrd: line integrate: --interval requires a value")
      passthrough.push(arg, value)
      continue
    }
    if (arg.startsWith("--interval=")) {
      passthrough.push("--interval", arg.slice("--interval=".length))
      continue
    }
    if (arg === "--help" || arg === "-h") {
      console.log(LINE_USAGE)
      process.exit(0)
    }
    if (arg.startsWith("-")) fail(`yrd: line integrate: unknown option '${arg}'`)
    if (target !== undefined) fail(`yrd: line integrate: unexpected extra argument '${arg}'`)
    target = arg
  }

  return { target, steps: parseSteps(stepsRaw), retry, passthrough }
}

async function lineIntegrate(args: string[]): Promise<void> {
  const parsed = parseIntegrateArgs(args)
  const stepKey = parsed.steps.join(",")

  if (parsed.retry) {
    if (parsed.target === undefined) fail("yrd: line integrate: --retry requires a PR or name")
    if (stepKey !== "check,merge") {
      fail("yrd: line integrate: --retry resumes the configured line; use --steps check,merge or omit --steps")
    }
    if (parsed.passthrough.length > 0) fail("yrd: line integrate: --retry does not support --watch/--interval")
    await reenterGitBay(["retry", parsed.target])
    return
  }

  if (stepKey === "check") {
    if (parsed.target === undefined) fail("yrd: line integrate --steps check requires a PR or name")
    if (parsed.passthrough.length > 0) fail("yrd: line integrate --steps check does not support --watch/--interval")
    await reenterGitBay(["check", parsed.target])
    return
  }

  if (stepKey === "merge") {
    if (parsed.target === undefined) fail("yrd: line integrate --steps merge requires a PR or name")
    if (parsed.passthrough.length > 0) fail("yrd: line integrate --steps merge does not support --watch/--interval")
    await reenterGitBay(["merge", parsed.target])
    return
  }

  if (stepKey !== "check,merge") {
    fail(`yrd: line integrate: unsupported step order '${stepKey}' (installed sequence: check,merge)`)
  }

  await reenterGitBay(["integrate", ...(parsed.target === undefined ? [] : [parsed.target]), ...parsed.passthrough])
}

async function lineProjection(args: string[]): Promise<void> {
  const command = args[0]
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(LINE_USAGE)
    return
  }
  if (command === "status") {
    await reenterGitBay(["ls", ...args.slice(1)])
    return
  }
  if (command === "audit") {
    await reenterGitBay(["audit", ...args.slice(1)])
    return
  }
  if (command === "watch") {
    await reenterGitBay(["integrate", ...args.slice(1), "--watch"])
    return
  }
  if (command === "integrate") {
    await lineIntegrate(args.slice(1))
    return
  }
  if (command === "provision" || command === "deprovision") {
    fail(`yrd: line ${command}: staged, not installed yet`)
  }
  fail(`yrd: unknown line command '${command}' (installed: status, audit, integrate, watch)`)
}

if (projection === undefined || projection === "--help" || projection === "-h" || projection === "help") {
  printUsage()
} else if (projection === "bay") {
  await reenterGitBay(process.argv.slice(3))
} else if (projection === "line") {
  await lineProjection(process.argv.slice(3))
} else {
  fail(`yrd: unknown projection '${projection}' (installed: bay, line)`)
}

export {}
