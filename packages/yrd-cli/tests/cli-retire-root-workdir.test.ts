/**
 * @failure `yrd queue retire-root` resolved its host workdir with NO Git instance, so a declared
 *   `git config yrd.workdir` was never read and the verb looked for the live root under the
 *   `$XDG_STATE_HOME/yrd` fallback. On a host that declares its own workdir the verb refused its own
 *   live root by name (`yrd-retire-no-live-root`) and could not run at all, and no cwd or environment
 *   reached the declared root (28601, measured 2026-10-10 19:05 PDT). A resolution that stopped at
 *   the repository boundary would move the same defect to another config scope, where `resolveQueueLocation`
 *   already reads one: a GLOBAL `yrd.workdir` outside any repository (@cto 044d3ffd change 1).
 * @level    l2 (real git repositories declaring the workdir, a real CLI invocation, real `tar`)
 * @consumer the operator running `yrd queue retire-root` after @chief's word
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { legacyQueueRoot, parseQueueAddress, queueRoot } from "../src/address.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []
const address = parseQueueAddress("github.com/beorn/hh#main")

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const pinned = {
  configGlobal: process.env.GIT_CONFIG_GLOBAL,
  noSystem: process.env.GIT_CONFIG_NOSYSTEM,
  state: process.env.XDG_STATE_HOME,
}
afterEach(() => {
  restore("XDG_STATE_HOME", pinned.state)
  restore("GIT_CONFIG_GLOBAL", pinned.configGlobal)
  restore("GIT_CONFIG_NOSYSTEM", pinned.noSystem)
})

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** The live `~` sibling and the percent-escaped root, planted under `declared` only. */
function plant(declared: string): Readonly<{ retired: string }> {
  const retired = legacyQueueRoot(declared, address)
  mkdirSync(join(queueRoot(declared, address), "repo"), { recursive: true })
  mkdirSync(join(retired, "repo"), { recursive: true })
  writeFileSync(join(retired, "repo.lock"), "")
  return { retired }
}

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

async function yrd(cwd: string, ...args: string[]): Promise<Ran> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    color: false,
    cwd,
    stderr(text) {
      stderr += text
    },
    stdout(text) {
      stdout += text
    },
  }
  const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...args], io)
  return {
    exitCode,
    report: `yrd ${args.join(" ")} exited ${String(exitCode)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    stderr,
    stdout,
  }
}

/** A dry run that succeeded: retired under `declared`, and never a word about the decoy. */
function retirementOf(run: Ran, declared: string, decoy: string): string {
  expect(run.exitCode, run.report).toBe(0)
  expect(run.stderr).not.toContain(join(decoy, "yrd"))
  const result = JSON.parse(run.stdout) as Readonly<{ archive: string; dryRun: boolean; root: string }>
  expect(result.dryRun).toBe(true)
  expect(result.archive.startsWith(join(declared, "github.com", "beorn", ".retired"))).toBe(true)
  return result.root
}

describe("`yrd queue retire-root` host workdir (28601)", () => {
  it("reads a LOCAL git config yrd.workdir, never the XDG fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-retire-workdir-"))
    roots.push(root)
    const declared = join(root, "declared-host")
    const clone = join(root, "clone")
    mkdirSync(clone, { recursive: true })
    const git = gitIn(clone)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git(["config", "yrd.workdir", declared])
    const { retired } = plant(declared)

    // A decoy the fallback would have used: nothing is planted under it.
    const decoy = join(root, "xdg-state")
    process.env.XDG_STATE_HOME = decoy

    const run = await yrd(clone, "queue", "retire-root", "github.com/beorn/hh#main", "--dry-run", "--json")
    expect(retirementOf(run, declared, decoy)).toBe(retired)
  })

  it("reads a GLOBAL git config yrd.workdir outside any repository, as resolveQueueLocation does", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-retire-global-"))
    roots.push(root)
    const declared = join(root, "declared-host")
    const { retired } = plant(declared)

    // No repository here at all: the declaration lives in GLOBAL config only.
    const configGlobal = join(root, "gitconfig")
    writeFileSync(configGlobal, `[yrd]\n\tworkdir = ${declared}\n`)
    process.env.GIT_CONFIG_GLOBAL = configGlobal
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    const decoy = join(root, "xdg-state")
    process.env.XDG_STATE_HOME = decoy

    const run = await yrd(root, "queue", "retire-root", "github.com/beorn/hh#main", "--dry-run", "--json")
    expect(retirementOf(run, declared, decoy)).toBe(retired)
  })

  it("keeps the XDG fallback when NO config scope declares yrd.workdir", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-retire-noscope-"))
    roots.push(root)
    process.env.GIT_CONFIG_GLOBAL = join(root, "absent-gitconfig")
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    const decoy = join(root, "xdg-state")
    process.env.XDG_STATE_HOME = decoy

    const run = await yrd(root, "queue", "retire-root", "github.com/beorn/hh#main", "--dry-run", "--json")
    expect(run.exitCode, run.report).not.toBe(0)
    expect(run.stderr).toContain("yrd-retire-no-live-root")
    expect(run.stderr).toContain(join(decoy, "yrd"))
  })
})
