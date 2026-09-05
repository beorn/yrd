/**
 * @failure  The operator's spelling is `yrd list`; the CLI's was `yrd queue
 *           list`. A missing alias is a refusal at the prompt ("unknown
 *           command 'list'") for the one read the operator makes most, and an
 *           alias that is a second implementation drifts from the canonical
 *           command the first time either grows a flag.
 * @consumer the operator at the prompt (2026-09-04: "yrd list = yrd queue
 *           list") · the /yrd skill, which keeps `yrd queue list` canonical
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

/** A bare remote whose `main` declares the queue, a clone of it, and one change submitted from the clone. */
async function queueWithOneChange(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-list-alias-"))
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
  writeFileSync(join(work, ".yrd.yml"), "target: origin#main\nchecks:\n  - verify:\n      run: test -f pass.txt\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  await git(["checkout", "--quiet", "-b", "task/one", "main"])
  writeFileSync(join(work, "pass.txt"), "pass\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "task/one does its work"])
  await git(["checkout", "--quiet", "main"])
  await submit(git, "origin", {
    branch: "task/one",
    submitter: "@dev/10",
    target: { branch: "main", remote: "origin" },
  })
  mkdirSync(join(root, "queue"), { recursive: true })
  return work
}

/** The `--json` reading with the one field that names the moment it was taken removed, so two readings compare. */
function timeless(json: string): unknown {
  const parsed = JSON.parse(json) as Record<string, unknown>
  const { journal: _journal, ...rest } = parsed
  return rest
}

describe("`yrd list` is `yrd queue list`", () => {
  it("prints the same reading with the same exit code", async () => {
    const work = await queueWithOneChange()

    const canonical = await yrd(work, "queue", "list", "--json")
    const alias = await yrd(work, "list", "--json")

    expect(canonical.exitCode, canonical.report).toBe(0)
    expect(alias.exitCode, alias.report).toBe(canonical.exitCode)
    expect(timeless(alias.stdout)).toEqual(timeless(canonical.stdout))
    const rows = (JSON.parse(alias.stdout) as { changes: readonly { branch: string }[] }).changes
    expect(rows.map((row) => row.branch)).toEqual(["task/one"])
  })

  it("takes the same positional filters and the same flags", async () => {
    const work = await queueWithOneChange()

    const canonical = await yrd(work, "queue", "list", "--latest", "--json", "no-such-branch")
    const alias = await yrd(work, "list", "--latest", "--json", "no-such-branch")
    expect(alias.exitCode, alias.report).toBe(canonical.exitCode)
    expect(timeless(alias.stdout)).toEqual(timeless(canonical.stdout))

    // One option table, read from the help of each: the alias can never grow apart from the command.
    const flagsOf = (help: string): string[] =>
      [...help.matchAll(/^\s+(--[a-z-]+)/gmu)].map((match) => match[1] ?? "").sort()
    const canonicalHelp = await yrd(work, "queue", "list", "--help")
    const aliasHelp = await yrd(work, "list", "--help")
    expect(canonicalHelp.exitCode, canonicalHelp.report).toBe(0)
    expect(aliasHelp.exitCode, aliasHelp.report).toBe(0)
    expect(flagsOf(aliasHelp.stdout)).toEqual(["--interval", "--json", "--latest", "--watch"])
    expect(flagsOf(aliasHelp.stdout)).toEqual(flagsOf(canonicalHelp.stdout))
    expect(aliasHelp.stdout).toContain("[filter...]")
  })

  it("is listed as an alias in `yrd --help`, with `yrd queue list` as the canonical spelling", async () => {
    const work = await queueWithOneChange()

    const help = await yrd(work, "--help")
    expect(help.exitCode, help.report).toBe(0)
    const aliases = help.stdout.slice(help.stdout.indexOf("Aliases:"), help.stdout.indexOf("Examples:"))
    expect(aliases).toMatch(/yrd list\s+yrd queue list/u)
    // The examples keep teaching the canonical form.
    expect(help.stdout).toContain("$ yrd queue list")
  })
})
