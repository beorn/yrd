// @failure Submodule branch tracking misreads .gitmodules, warns wrongly, or `yrd init` sets the wrong branch / overwrites an explicit one.
// @level l2
// @consumer @yrd/cli

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createProcess } from "@yrd/process"
import { createJournal } from "@yrd/persistence"
import { createDefaultYrdApp, runYrd, type YrdCliApp, type YrdCliIO } from "@yrd/cli"
import type { ResolvedYrdProjectConfig } from "../src/config.ts"
import { printResultWithWarnings } from "../src/output.tsx"
import {
  createSubmoduleBranchResolver,
  formatSubmoduleTrackingWarning,
  parseGitmodules,
  readSubmoduleEntries,
  resolveSubmoduleUrl,
  setSubmoduleBranch,
  submoduleTrackingWarnings,
  superprojectOrigin,
  superprojectRoot,
  unbranchedSubmodules,
  type SubmoduleBranchResolution,
  type SubmoduleEntry,
} from "../src/submodule-tracking.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

/** A real Git superproject whose `.gitmodules` is fabricated directly — no
 * submodule checkout, no network — which is all the reader/warn/init paths
 * touch. */
async function superproject(gitmodules?: string, origin?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-track-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await git(root, "init", "-q", "-b", "main")
  await git(root, "config", "user.name", "Yrd Test")
  await git(root, "config", "user.email", "yrd@example.invalid")
  if (origin !== undefined) await git(root, "remote", "add", "origin", origin)
  await writeFile(join(root, ".yrd.yml"), "base: main\nbatch: 1\nsteps: [check, merge]\ncheck: \"true\"\nmerge: {}\n")
  if (gitmodules !== undefined) await writeFile(join(root, ".gitmodules"), gitmodules)
  await git(root, "add", "-A")
  await git(root, "commit", "-qm", "base")
  return root
}

const TWO_SUBMODULES = [
  '[submodule "vendor/foo"]',
  "\tpath = vendor/foo",
  "\turl = https://example.com/foo.git",
  '[submodule "vendor/bar"]',
  "\tpath = vendor/bar",
  "\turl = https://example.com/bar.git",
  "\tbranch = release",
  "",
].join("\n")

const config: ResolvedYrdProjectConfig = {
  base: "main",
  batch: 1,
  steps: ["check", "merge"],
  requires: [],
  definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
  contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
}

async function appFor(repo: string): Promise<YrdCliApp> {
  const stateDir = join(repo, ".git", "yrd")
  const log = createLogger("yrd", [{ level: "silent" }])
  const runtimeProcess = createProcess({ cwd: repo })
  const app = await createDefaultYrdApp({
    repo,
    stateDir,
    baysRoot: join(repo, ".bays"),
    journal: createJournal({ dir: stateDir, inject: { log } }),
    process: runtimeProcess,
    config,
    log,
  })
  cleanups.push(async () => {
    await app.close()
    await runtimeProcess.close()
  })
  return app
}

function outputIO(overrides: Partial<YrdCliIO> = {}): {
  io: YrdCliIO
  stdout: () => string
  stderr: () => string
} {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    runner: "cli-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-20T12:00:00.000Z"),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

describe("parseGitmodules", () => {
  it("groups NUL records by submodule, capturing path/url/branch", () => {
    const nul =
      "submodule.vendor/foo.path\nvendor/foo\0" +
      "submodule.vendor/foo.url\nhttps://example.com/foo.git\0" +
      "submodule.vendor/bar.path\nvendor/bar\0" +
      "submodule.vendor/bar.url\n../bar.git\0" +
      "submodule.vendor/bar.branch\nmain\0"
    expect(parseGitmodules(nul)).toEqual([
      { name: "vendor/foo", path: "vendor/foo", url: "https://example.com/foo.git" },
      { name: "vendor/bar", path: "vendor/bar", url: "../bar.git", branch: "main" },
    ] satisfies SubmoduleEntry[])
  })

  it("keeps a subsection name containing dots intact", () => {
    const nul = "submodule.deps/a.b.path\ndeps/a.b\0submodule.deps/a.b.branch\nmain\0"
    expect(parseGitmodules(nul)).toEqual([{ name: "deps/a.b", path: "deps/a.b", branch: "main" }])
  })

  it("treats an empty branch value as untracked, and defaults a missing path to the name", () => {
    const nul = "submodule.x.url\nhttps://e/x.git\0submodule.x.branch\n\0"
    expect(parseGitmodules(nul)).toEqual([{ name: "x", path: "x", url: "https://e/x.git" }])
  })

  it("returns an empty list for empty output", () => {
    expect(parseGitmodules("")).toEqual([])
  })

  it("throws loudly on a malformed record", () => {
    expect(() => parseGitmodules("no-newline-here\0")).toThrow(/invalid NUL record/u)
  })
})

describe("unbranchedSubmodules + formatSubmoduleTrackingWarning", () => {
  const entries: SubmoduleEntry[] = [
    { name: "vendor/c", path: "vendor/c", url: "u" },
    { name: "vendor/a", path: "vendor/a", url: "u", branch: "main" },
    { name: "vendor/b", path: "vendor/b", url: "u" },
  ]

  it("selects only entries without a branch", () => {
    expect(unbranchedSubmodules(entries).map((entry) => entry.path)).toEqual(["vendor/c", "vendor/b"])
  })

  it("formats one line, plural, paths sorted, with the init hint", () => {
    expect(formatSubmoduleTrackingWarning(unbranchedSubmodules(entries))).toBe(
      "warn: 2 submodules not tracking a branch (rolls disabled): vendor/b, vendor/c — run 'yrd init' to set",
    )
  })

  it("uses the singular noun for one", () => {
    expect(formatSubmoduleTrackingWarning([{ name: "vendor/x", path: "vendor/x" }])).toBe(
      "warn: 1 submodule not tracking a branch (rolls disabled): vendor/x — run 'yrd init' to set",
    )
  })

  it("returns undefined when everything tracks a branch", () => {
    expect(formatSubmoduleTrackingWarning([])).toBeUndefined()
  })
})

describe("resolveSubmoduleUrl", () => {
  it("passes absolute https and scp URLs through unchanged", () => {
    expect(resolveSubmoduleUrl("/repo", undefined, "https://example.com/x.git")).toBe("https://example.com/x.git")
    expect(resolveSubmoduleUrl("/repo", undefined, "git@github.com:owner/x.git")).toBe("git@github.com:owner/x.git")
  })

  it("resolves ../ against an https superproject origin", () => {
    expect(resolveSubmoduleUrl("/repo", "https://github.com/owner/super.git", "../dep.git")).toBe(
      "https://github.com/owner/dep.git",
    )
  })

  it("resolves ../ against an scp superproject origin", () => {
    expect(resolveSubmoduleUrl("/repo", "git@github.com:owner/super.git", "../dep.git")).toBe(
      "git@github.com:owner/dep.git",
    )
  })

  it("throws when a relative URL has no superproject origin", () => {
    expect(() => resolveSubmoduleUrl("/repo", undefined, "../dep.git")).toThrow(/no superproject origin/u)
  })
})

describe("real Git helpers against a fixture", () => {
  it("reads entries and computes the advisory warning", async () => {
    const root = await superproject(TWO_SUBMODULES)
    expect(superprojectRoot(root)).toBe(await git(root, "rev-parse", "--show-toplevel"))
    expect(readSubmoduleEntries(root)).toEqual([
      { name: "vendor/foo", path: "vendor/foo", url: "https://example.com/foo.git" },
      { name: "vendor/bar", path: "vendor/bar", url: "https://example.com/bar.git", branch: "release" },
    ])
    expect(submoduleTrackingWarnings(root)).toEqual([
      "warn: 1 submodule not tracking a branch (rolls disabled): vendor/foo — run 'yrd init' to set",
    ])
  })

  it("reads the origin remote and writes a branch without committing", async () => {
    const root = await superproject(TWO_SUBMODULES, "https://github.com/owner/super.git")
    expect(superprojectOrigin(root)).toBe("https://github.com/owner/super.git")
    setSubmoduleBranch(root, "vendor/foo", "main")
    expect(await git(root, "config", "--file", ".gitmodules", "--get", "submodule.vendor/foo.branch")).toBe("main")
    // The edit is left uncommitted for the operator to review.
    expect(await git(root, "status", "--porcelain")).toContain(".gitmodules")
  })

  it("emits no warning for a non-superproject directory", async () => {
    const root = await superproject()
    expect(readSubmoduleEntries(root)).toEqual([])
    expect(submoduleTrackingWarnings(root)).toEqual([])
  })

  it("yields no root or warning for a path that cannot be a Git worktree", () => {
    expect(superprojectRoot("/does/not/exist")).toBeUndefined()
    expect(submoduleTrackingWarnings("/does/not/exist")).toEqual([])
  })
})

describe("createSubmoduleBranchResolver (real ls-remote)", () => {
  it("resolves the default branch of a reachable local remote", async () => {
    const remote = await mkdtemp(join(tmpdir(), "yrd-remote-"))
    cleanups.push(() => rm(remote, { recursive: true, force: true }))
    await git(remote, "init", "-q", "-b", "trunk")
    await git(remote, "config", "user.name", "Yrd Test")
    await git(remote, "config", "user.email", "yrd@example.invalid")
    await git(remote, "commit", "-q", "--allow-empty", "-m", "init")
    const resolution = await createSubmoduleBranchResolver(remote)(remote)
    expect(resolution).toEqual({ status: "resolved", branch: "trunk" })
  })

  it("reports an unreachable remote instead of throwing", async () => {
    const resolution = await createSubmoduleBranchResolver(tmpdir())("/no/such/remote.git")
    expect(resolution.status).toBe("unreachable")
  })
})

describe("printResultWithWarnings", () => {
  const warning = "warn: 1 submodule not tracking a branch (rolls disabled): vendor/foo — run 'yrd init' to set"

  it("appends a warnings array in JSON mode without disturbing the value", async () => {
    const out = outputIO()
    await printResultWithWarnings(out.io, true, { command: "queue.list", results: [] }, "unused", [warning])
    expect(JSON.parse(out.stdout())).toEqual({ command: "queue.list", results: [], warnings: [warning] })
    expect(out.stderr()).toBe("")
  })

  it("omits the warnings field in JSON mode when there are none", async () => {
    const out = outputIO()
    await printResultWithWarnings(out.io, true, { command: "queue.list", results: [] }, "unused", [])
    expect(JSON.parse(out.stdout())).toEqual({ command: "queue.list", results: [] })
  })

  it("writes the human output to stdout and one warning line per warning to stderr", async () => {
    const out = outputIO()
    await printResultWithWarnings(out.io, false, { command: "queue.list" }, "the timeline", [warning])
    expect(out.stdout()).toContain("the timeline")
    expect(out.stderr()).toBe(`${warning}\n`)
  })

  it("writes no stderr in human mode when there are no warnings", async () => {
    const out = outputIO()
    await printResultWithWarnings(out.io, false, { command: "queue.list" }, "the timeline", [])
    expect(out.stderr()).toBe("")
  })
})

describe("queue list / dashboard warning surface", () => {
  it("adds a warnings array in --json without touching results", async () => {
    const root = await superproject(TWO_SUBMODULES)
    const app = await appFor(root)
    const out = outputIO({ cwd: root })
    expect(await runYrd(app, yrd("queue", "list", "--json"), out.io), out.stderr()).toBe(0)
    const payload = JSON.parse(out.stdout()) as { command: string; warnings?: string[]; results: unknown[] }
    expect(payload.command).toBe("queue.list")
    expect(payload.warnings).toEqual([
      "warn: 1 submodule not tracking a branch (rolls disabled): vendor/foo — run 'yrd init' to set",
    ])
  })

  it("adds no warnings field when every submodule tracks a branch", async () => {
    const root = await superproject(
      [
        '[submodule "vendor/bar"]',
        "\tpath = vendor/bar",
        "\turl = https://example.com/bar.git",
        "\tbranch = release",
        "",
      ].join("\n"),
    )
    const app = await appFor(root)
    const out = outputIO({ cwd: root })
    expect(await runYrd(app, yrd("queue", "list", "--json"), out.io), out.stderr()).toBe(0)
    expect(JSON.parse(out.stdout())).not.toHaveProperty("warnings")
    expect(out.stderr()).not.toContain("warn:")
  })

  it("surfaces the warning on the bare dashboard too", async () => {
    const root = await superproject(TWO_SUBMODULES)
    const app = await appFor(root)
    const out = outputIO({ cwd: root })
    expect(await runYrd(app, yrd("--json"), out.io), out.stderr()).toBe(0)
    const payload = JSON.parse(out.stdout()) as { command: string; warnings?: string[] }
    expect(payload.command).toBe("dashboard")
    expect(payload.warnings).toEqual([
      "warn: 1 submodule not tracking a branch (rolls disabled): vendor/foo — run 'yrd init' to set",
    ])
  })
})

const resolved = (branch: string): SubmoduleBranchResolution => ({ status: "resolved", branch })

describe("yrd init", () => {
  it("sets a branch for unbranched submodules, never overwriting an explicit one", async () => {
    const root = await superproject(TWO_SUBMODULES)
    const app = await appFor(root)
    const out = outputIO({ cwd: root, resolveSubmoduleDefaultBranch: () => resolved("main") })
    expect(await runYrd(app, yrd("init", "--json"), out.io), out.stderr()).toBe(0)
    const payload = JSON.parse(out.stdout()) as {
      command: string
      alreadyTracking: number
      results: Array<{ path: string; branch?: string; action: string; source: string }>
    }
    expect(payload.command).toBe("init")
    expect(payload.alreadyTracking).toBe(1)
    expect(payload.results).toEqual([{ name: "vendor/foo", path: "vendor/foo", url: "https://example.com/foo.git", branch: "main", source: "remote", action: "set" }])
    // vendor/foo now tracks; vendor/bar's explicit branch is untouched.
    expect(await git(root, "config", "--file", ".gitmodules", "--get", "submodule.vendor/foo.branch")).toBe("main")
    expect(await git(root, "config", "--file", ".gitmodules", "--get", "submodule.vendor/bar.branch")).toBe("release")
  })

  it("--dry-run writes nothing and reports would-set", async () => {
    const root = await superproject(TWO_SUBMODULES)
    const app = await appFor(root)
    const before = await readFile(join(root, ".gitmodules"), "utf8")
    const out = outputIO({ cwd: root, resolveSubmoduleDefaultBranch: () => resolved("main") })
    expect(await runYrd(app, yrd("init", "--dry-run", "--json"), out.io), out.stderr()).toBe(0)
    const payload = JSON.parse(out.stdout()) as { dryRun: boolean; results: Array<{ action: string }> }
    expect(payload.dryRun).toBe(true)
    expect(payload.results.map((row) => row.action)).toEqual(["would-set"])
    expect(await readFile(join(root, ".gitmodules"), "utf8")).toBe(before)
  })

  it("prints a human summary table and a commit hint", async () => {
    const root = await superproject(TWO_SUBMODULES)
    const app = await appFor(root)
    const out = outputIO({ cwd: root, resolveSubmoduleDefaultBranch: () => resolved("main") })
    expect(await runYrd(app, yrd("init"), out.io), out.stderr()).toBe(0)
    const text = out.stdout()
    expect(text).toContain("SUBMODULE")
    expect(text).toContain("vendor/foo")
    expect(text).toContain("remote HEAD")
    expect(text).toContain("commit -m 'chore: track submodule branches'")
  })

  it("takes the documented main fallback and prints a note when the remote HEAD names no branch", async () => {
    const root = await superproject(TWO_SUBMODULES)
    const app = await appFor(root)
    const out = outputIO({
      cwd: root,
      resolveSubmoduleDefaultBranch: () => ({ status: "fallback", branch: "main", note: "remote HEAD named no branch; defaulting to main" }),
    })
    expect(await runYrd(app, yrd("init", "--json"), out.io), out.stderr()).toBe(0)
    const payload = JSON.parse(out.stdout()) as { results: Array<{ source: string; branch?: string; note?: string }> }
    expect(payload.results[0]!.source).toBe("fallback")
    expect(payload.results[0]!.branch).toBe("main")
    expect(payload.results[0]!.note).toContain("defaulting to main")
    expect(await git(root, "config", "--file", ".gitmodules", "--get", "submodule.vendor/foo.branch")).toBe("main")
  })

  it("lists unreachable remotes but exits 0 when at least one resolved", async () => {
    const both = [
      '[submodule "vendor/foo"]',
      "\tpath = vendor/foo",
      "\turl = https://example.com/foo.git",
      '[submodule "vendor/baz"]',
      "\tpath = vendor/baz",
      "\turl = https://example.com/baz.git",
      "",
    ].join("\n")
    const root = await superproject(both)
    const app = await appFor(root)
    const out = outputIO({
      cwd: root,
      resolveSubmoduleDefaultBranch: (url) =>
        url.includes("foo") ? resolved("main") : { status: "unreachable", detail: "could not connect" },
    })
    expect(await runYrd(app, yrd("init", "--json"), out.io), out.stderr()).toBe(0)
    const payload = JSON.parse(out.stdout()) as { results: Array<{ path: string; action: string }>; failures?: unknown[] }
    expect(payload.results.map((row) => `${row.path}:${row.action}`)).toEqual([
      "vendor/baz:unreachable",
      "vendor/foo:set",
    ])
    expect(payload.failures).toHaveLength(1)
  })

  it("exits 1 when every unbranched submodule is unreachable", async () => {
    const root = await superproject(
      ['[submodule "vendor/foo"]', "\tpath = vendor/foo", "\turl = https://example.com/foo.git", ""].join("\n"),
    )
    const app = await appFor(root)
    const out = outputIO({
      cwd: root,
      resolveSubmoduleDefaultBranch: () => ({ status: "unreachable", detail: "network down" }),
    })
    expect(await runYrd(app, yrd("init", "--json"), out.io)).toBe(1)
  })

  it("reports when all submodules already track a branch", async () => {
    const root = await superproject(
      [
        '[submodule "vendor/bar"]',
        "\tpath = vendor/bar",
        "\turl = https://example.com/bar.git",
        "\tbranch = release",
        "",
      ].join("\n"),
    )
    const app = await appFor(root)
    const out = outputIO({ cwd: root, resolveSubmoduleDefaultBranch: () => resolved("main") })
    expect(await runYrd(app, yrd("init"), out.io), out.stderr()).toBe(0)
    expect(out.stdout()).toContain("already track a branch")
  })

  it("reports when there are no submodules at all", async () => {
    const root = await superproject()
    const app = await appFor(root)
    const out = outputIO({ cwd: root })
    expect(await runYrd(app, yrd("init"), out.io), out.stderr()).toBe(0)
    expect(out.stdout()).toContain("no submodules declared")
  })
})
