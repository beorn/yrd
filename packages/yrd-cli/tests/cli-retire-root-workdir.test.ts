/**
 * @failure `yrd queue retire-root` resolved its host workdir with NO Git instance, so a declared
 *   `git config yrd.workdir` was never read and the verb looked for the live root under the
 *   `$XDG_STATE_HOME/yrd` fallback. On a host that declares its own workdir the verb refused its own
 *   live root by name (`yrd-retire-no-live-root`) and could not run at all, and no cwd or environment
 *   reached the declared root (28601, measured 2026-10-10 19:05 PDT).
 * @level    l2 (a real git repository declaring its workdir, a real CLI invocation, real `tar`)
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

const pinned = process.env.XDG_STATE_HOME
afterEach(() => {
  if (pinned === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = pinned
})

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

describe("`yrd queue retire-root` host workdir (28601)", () => {
  it("reads the declared git config yrd.workdir, never the XDG fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-retire-workdir-"))
    roots.push(root)
    const declared = join(root, "declared-host")
    const clone = join(root, "clone")
    mkdirSync(clone, { recursive: true })
    const git = gitIn(clone)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git(["config", "yrd.workdir", declared])

    // The live ~ sibling and the percent-escaped root exist under the DECLARED host only.
    const live = queueRoot(declared, address)
    const retired = legacyQueueRoot(declared, address)
    mkdirSync(join(live, "repo"), { recursive: true })
    mkdirSync(join(retired, "repo"), { recursive: true })
    writeFileSync(join(retired, "repo.lock"), "")

    // A decoy the fallback would have used: nothing is planted under it.
    const decoy = join(root, "xdg-state")
    process.env.XDG_STATE_HOME = decoy

    const run = await yrd(clone, "queue", "retire-root", "github.com/beorn/hh#main", "--dry-run", "--json")
    expect(run.exitCode, run.report).toBe(0)
    expect(run.stderr).not.toContain(join(decoy, "yrd"))
    const result = JSON.parse(run.stdout) as Readonly<{ archive: string; dryRun: boolean; root: string }>
    expect(result.dryRun).toBe(true)
    expect(result.root).toBe(retired)
    expect(result.archive.startsWith(join(declared, "github.com", "beorn", ".retired"))).toBe(true)
  })

  it("keeps the XDG fallback outside a repository: nothing to read, so the checkout decides", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-retire-norepo-"))
    roots.push(root)
    const decoy = join(root, "xdg-state")
    process.env.XDG_STATE_HOME = decoy

    const run = await yrd(root, "queue", "retire-root", "github.com/beorn/hh#main", "--dry-run", "--json")
    expect(run.exitCode, run.report).not.toBe(0)
    expect(run.stderr).toContain("yrd-retire-no-live-root")
    expect(run.stderr).toContain(join(decoy, "yrd"))
  })
})
