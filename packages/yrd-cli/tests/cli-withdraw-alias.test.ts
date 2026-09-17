/**
 * @failure  `yrd withdraw` is the verb beside `yrd submit` and `yrd merge`
 *           (24824, absorbing design 3b § 1). Without the top-level spelling the
 *           prompt answers "unknown command 'withdraw'" for the one ending an
 *           operator writes by hand, and an alias that is a second
 *           implementation drifts from `yrd queue withdraw` the first time
 *           either spelling grows a flag.
 * @consumer the operator ending a change at the prompt · the stuck record's
 *           cures, which name withdraw first · the /yrd skill, which keeps
 *           `yrd queue withdraw` working
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, submit } from "@yrd/queue-core"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

/** The CLI as the shell runs it: argv in, exit code and both streams out. */
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

/** A bare remote whose `main` declares the queue, a clone of it, and one change per named branch. */
async function queueWithChanges(...branches: readonly string[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-withdraw-alias-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f pass.txt\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  for (const branch of branches) {
    await git(["checkout", "--quiet", "-b", branch, "main"])
    writeFileSync(join(work, "pass.txt"), `${branch}\n`)
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", `${branch} does its work`])
    await git(["checkout", "--quiet", "main"])
    await submit(git, "origin", { branch, submitter: "@dev/10", target: { branch: "main", remote: "origin" } })
  }
  mkdirSync(join(root, "queue"), { recursive: true })
  return work
}

/** One withdrawal's reading with the branch it names and every sha replaced, so two branches' readings compare. */
function shapeOf(text: string, branch: string): string {
  return text.replaceAll(branch, "<branch>").replaceAll(/[0-9a-f]{7,40}/gu, "<sha>")
}

/** The state `yrd list --json` reads for one branch. */
async function stateOf(work: string, branch: string): Promise<string | undefined> {
  const listed = await yrd(work, "list", "--json")
  expect(listed.exitCode, listed.report).toBe(0)
  const rows = (JSON.parse(listed.stdout) as { changes: readonly { branch: string; state: string }[] }).changes
  return rows.find((row) => row.branch === branch)?.state
}

describe("`yrd withdraw` is `yrd queue withdraw`", () => {
  it("ends the change the same way, with the same reading and the same exit code", async () => {
    const work = await queueWithChanges("task/one", "task/two")

    const canonical = await yrd(work, "queue", "withdraw", "task/one", "--json", "--reason", "the operator said so")
    const alias = await yrd(work, "withdraw", "task/two", "--json", "--reason", "the operator said so")

    expect(canonical.exitCode, canonical.report).toBe(0)
    expect(alias.exitCode, alias.report).toBe(canonical.exitCode)
    expect(shapeOf(alias.stdout, "task/two")).toBe(shapeOf(canonical.stdout, "task/one"))
    // The ending is real on both, and it is the branch each command named.
    expect(await stateOf(work, "task/one")).toBe("withdrawn")
    expect(await stateOf(work, "task/two")).toBe("withdrawn")
  })

  it("prints the same line without --json, and refuses the same way when nothing is in line", async () => {
    const work = await queueWithChanges("task/one", "task/two")

    const canonical = await yrd(work, "queue", "withdraw", "task/one")
    const alias = await yrd(work, "withdraw", "task/two")
    expect(alias.exitCode, alias.report).toBe(canonical.exitCode)
    expect(shapeOf(alias.stdout, "task/two")).toBe(shapeOf(canonical.stdout, "task/one"))

    // Nothing left to end: the same refusal, byte for byte, on the same branch.
    const refusedCanonical = await yrd(work, "queue", "withdraw", "task/one")
    const refusedAlias = await yrd(work, "withdraw", "task/one")
    expect(refusedCanonical.exitCode, refusedCanonical.report).toBe(1)
    expect(refusedAlias.exitCode, refusedAlias.report).toBe(1)
    expect(refusedAlias.stderr).toBe(refusedCanonical.stderr)
  })

  it("takes the same flags and teaches the alias in help", async () => {
    const work = await queueWithChanges("task/one")

    const flagsOf = (help: string): string[] =>
      [...help.matchAll(/^\s+(--[a-z-]+)/gmu)].map((match) => match[1] ?? "").sort()
    const canonicalHelp = await yrd(work, "queue", "withdraw", "--help")
    const aliasHelp = await yrd(work, "withdraw", "--help")
    expect(canonicalHelp.exitCode, canonicalHelp.report).toBe(0)
    expect(aliasHelp.exitCode, aliasHelp.report).toBe(0)
    expect(flagsOf(aliasHelp.stdout)).toEqual(["--json", "--notify", "--queue", "--reason"])
    expect(flagsOf(aliasHelp.stdout)).toEqual(flagsOf(canonicalHelp.stdout))
    // One explanation, on both spellings.
    for (const help of [canonicalHelp, aliasHelp]) {
      expect(help.stdout, help.report).toContain("On withdraw:")
      expect(help.stdout.replace(/\s+/gu, " "), help.report).toContain("resubmitting the branch re-opens it")
    }

    const help = await yrd(work, "--help")
    expect(help.exitCode, help.report).toBe(0)
    const aliases = help.stdout.slice(help.stdout.indexOf("Aliases:"), help.stdout.indexOf("Examples:"))
    expect(aliases).toMatch(/yrd withdraw\s+yrd queue withdraw/u)
  })
})
