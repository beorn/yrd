/**
 * @failure  The bare `yrd` entry (node_modules/.bin/yrd, no host launcher) resolves its queue workdir from the
 *           caller's repository only, so from a checkout that declares no `yrd.workdir` it reads
 *           `$XDG_STATE_HOME/yrd` while the live runner writes the root the host's own repository declares:
 *           `yrd queue health` answered absent/stopped, exit 1, for a queue writing its document every 60 s,
 *           and its `why` named neither the root nor where it came from (hh 38659, hightea, 2026-11-25). The same
 *           probe given `git@github.com:owner/repo.git#main` built `github.com/git@github.com:owner/repo` and ran
 *           `git clone` (exit 2) from a command whose help says it reads a file and nothing else.
 * @level    l2 (real git repositories, a real submodule and linked worktree, the CLI in-process)
 * @consumer the supervisor probe and every seat running bare `yrd queue health` outside the queue's own clone
 * @testonly none
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { execFileSync } from "node:child_process"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { parseQueueAddress, queueRoot } from "../src/address.ts"
import { runYrdProcess } from "../src/cli.ts"
import { hostWorkdirHere, yrdOwnLocation } from "../src/queue-location.ts"
import { YRD_ENTRY } from "./support/yrd-entry.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []
afterAll(() => {
  // raw-delete-allow: the fixture roots these rows made with mkdtemp under tmpdir, and nothing else
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const VARIABLES = [
  "HOME",
  "XDG_STATE_HOME",
  "YRD_WORKDIR",
  "YRD_OWN_REPOSITORY",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_ALLOW_PROTOCOL",
  "GIT_TERMINAL_PROMPT",
  "PATH",
] as const
const saved = new Map(VARIABLES.map((name) => [name, process.env[name]]))
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: process.env }).trim()
}

function repository(path: string): string {
  mkdirSync(path, { recursive: true })
  sh(path, "init", "--quiet", "--initial-branch=main")
  sh(path, "config", "user.email", "yrd@yrd.test")
  sh(path, "config", "user.name", "yrd")
  writeFileSync(join(path, "README"), `${path}\n`)
  sh(path, "add", "README")
  sh(path, "commit", "--quiet", "-m", "seed")
  return path
}

type Host = Readonly<{
  root: string
  caller: string
  xdg: string
  /** The main checkout that declares `yrd.workdir`, as realpath. */
  host: string
  declared: string
  /** yrd's location inside a LINKED worktree's submodule, the shape of /hh/var/wt/<n>/vendor/yrd. */
  ownLocation: string
  gitLog: string
}>

/**
 * A host checkout declaring a RELATIVE `yrd.workdir`, yrd as its submodule, a linked worktree of the host with that
 * submodule materialized, and a caller repository that declares nothing. Git runs through a logging shim on PATH, so
 * a test can say which git commands the probe ran.
 */
function fixture(): Host {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yrd-health-root-")))
  roots.push(root)
  const home = join(root, "home")
  const xdg = join(root, "xdg")
  mkdirSync(home, { recursive: true })
  const globalConfig = join(root, "gitconfig")
  writeFileSync(globalConfig, "")
  process.env.HOME = home
  process.env.XDG_STATE_HOME = xdg
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  // Belt and braces: nothing here may reach a network even on the pre-fix code path that clones.
  process.env.GIT_ALLOW_PROTOCOL = "file"
  process.env.GIT_TERMINAL_PROMPT = "0"
  delete process.env.YRD_WORKDIR

  const component = repository(join(root, "component"))
  const host = repository(join(root, "host"))
  sh(host, "config", "yrd.workdir", "../declared")
  sh(host, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", component, "vendor/yrd")
  sh(host, "commit", "--quiet", "-m", "yrd as a submodule")
  const linked = join(root, "linked")
  sh(host, "worktree", "add", "--quiet", linked)
  sh(linked, "-c", "protocol.file.allow=always", "submodule", "update", "--quiet", "--init")
  const caller = repository(join(root, "caller"))

  const shim = join(root, "shim")
  const gitLog = join(root, "git.log")
  mkdirSync(shim)
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
  writeFileSync(join(shim, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexec '${realGit}' "$@"\n`)
  chmodSync(join(shim, "git"), 0o755)
  process.env.PATH = `${shim}:${process.env.PATH ?? ""}`

  return {
    root,
    caller,
    xdg,
    host,
    declared: join(root, "declared"),
    ownLocation: join(linked, "vendor", "yrd"),
    gitLog,
  }
}

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

async function yrd(cwd: string, ...args: string[]): Promise<Ran> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    localBranchProtections: null,
    color: false,
    cwd,
    stderr(text) {
      stderr += text
    },
    stdout(text) {
      stdout += text
    },
  }
  const exitCode = await runYrdProcess([process.execPath, YRD_ENTRY, ...args], io)
  return {
    exitCode,
    report: `yrd ${args.join(" ")} exited ${String(exitCode)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    stderr,
    stdout,
  }
}

function why(ran: Ran): string {
  const document = JSON.parse(ran.stdout) as { state: string; facts?: { why?: string } }
  expect(document.state, ran.report).toBe("absent")
  return document.facts?.why ?? ""
}

function gitCalls(host: Host): string[] {
  return existsSync(host.gitLog) ? readFileSync(host.gitLog, "utf8").split("\n").filter(Boolean) : []
}

const ADDRESS = "https://yrd.invalid/owner/repo.git#main"
const address = parseQueueAddress(ADDRESS)

describe("one workdir root for the bare yrd entry (38659)", () => {
  it("knows where it ships: its own location is this package's real path", () => {
    expect(yrdOwnLocation({})).toBe(realpathSync(join(dirname(YRD_ENTRY), "..", "packages", "yrd-cli", "src")))
  })

  it("reaches the root declared by yrd's own repository from a caller that declares none", async () => {
    const host = fixture()
    process.env.YRD_OWN_REPOSITORY = host.ownLocation
    // The linked worktree's submodule resolves to its superproject's MAIN checkout, whose relative value
    // resolves against that checkout, exactly as the launcher's landed root did.
    expect(await hostWorkdirHere(host.caller, process.env)).toBe(host.declared)
  })

  it("names the root and its source when the health document is absent", async () => {
    const host = fixture()
    process.env.YRD_OWN_REPOSITORY = host.ownLocation
    mkdirSync(queueRoot(host.declared, address), { recursive: true })
    const own = await yrd(host.caller, "queue", "health", "--queue", ADDRESS)
    expect(own.exitCode, own.report).toBe(1)
    const path = join(queueRoot(host.declared, address), "service-health.json")
    expect(why(own)).toContain(
      `no health document at ${path} (root ${host.declared} from yrd.workdir (yrd's own repository ${host.host}))`,
    )

    const override = join(host.root, "override")
    mkdirSync(queueRoot(override, address), { recursive: true })
    process.env.YRD_WORKDIR = override
    const env = await yrd(host.caller, "queue", "health", "--queue", ADDRESS)
    expect(env.exitCode, env.report).toBe(1)
    expect(why(env)).toContain(`(root ${override} from YRD_WORKDIR)`)
  })

  it("says the default root holds no queue, and that no declared root was found, instead of a quiet stopped", async () => {
    const host = fixture()
    const plain = repository(join(host.root, "plain"))
    process.env.YRD_OWN_REPOSITORY = plain
    const ran = await yrd(host.caller, "queue", "health", "--queue", ADDRESS)
    expect(ran.exitCode, ran.report).toBe(1)
    const xdgRoot = join(host.xdg, "yrd")
    const text = why(ran)
    expect(text).toContain(`no queue at ${queueRoot(xdgRoot, address)} (${xdgRoot} is the default)`)
    expect(text).toContain("declared roots: none found")
    expect(text).toContain(`yrd's own repository ${plain}`)
  })

  it("never clones: a missing workdir answers absent naming the path, and creates nothing", async () => {
    const host = fixture()
    process.env.YRD_OWN_REPOSITORY = host.ownLocation
    const workdir = join(host.root, "fresh")
    process.env.YRD_WORKDIR = workdir
    const local = `${repository(join(host.root, "remote"))}#main`
    const ran = await yrd(host.caller, "queue", "health", "--queue", local)
    expect(ran.exitCode, ran.report).toBe(1)
    expect(why(ran)).toContain(`no queue at ${queueRoot(workdir, parseQueueAddress(local))}`)
    expect(existsSync(workdir), "the probe created a workdir").toBe(false)
    expect(gitCalls(host).length, "the shim saw no git at all, so it proves nothing").toBeGreaterThan(0)
    expect(gitCalls(host).filter((call) => /^(clone|fetch|ls-remote)\b/u.test(call))).toEqual([])
  })

  it("never clones for an ssh address either, and reads it at its https twin's workdir", async () => {
    const host = fixture()
    process.env.YRD_OWN_REPOSITORY = host.ownLocation
    const ran = await yrd(host.caller, "queue", "health", "--queue", "git@yrd.invalid:owner/repo.git#main")
    expect(ran.exitCode, ran.report).toBe(1)
    expect(why(ran)).toContain(`no queue at ${queueRoot(host.declared, address)}`)
    expect(existsSync(host.declared), "the probe created the declared root").toBe(false)
    expect(gitCalls(host).filter((call) => /^(clone|fetch|ls-remote)\b/u.test(call))).toEqual([])
  })
})

describe("an ssh address is the same queue as its https twin (38659)", () => {
  it("maps every transport spelling to one canonical address and one workdir", () => {
    const https = parseQueueAddress("https://github.com/hallohuman/hightea.git#main")
    for (const spelling of [
      "git@github.com:hallohuman/hightea.git#main",
      "git@github.com:hallohuman/hightea.git@main",
      "github.com:hallohuman/hightea#main",
      "ssh://git@github.com/hallohuman/hightea.git#main",
      "hallohuman/hightea@main",
    ]) {
      const parsed = parseQueueAddress(spelling)
      expect(parsed.canonical, spelling).toBe(https.canonical)
      expect(queueRoot("/w", parsed), spelling).toBe("/w/github.com/hallohuman/hightea~main")
    }
  })
})
