/**
 * @failure A fresh environment ignored its commit's setup or ran it before
 *          dependencies existed; closing an unsafe environment discarded work.
 * @level   l2 (real bare remote and real retained Git worktree)
 * @consumer every seat opening a fresh environment through `yrd env open`
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, type Git } from "@yrd/queue-core"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string; stdout(): string }> {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      color: false,
      cwd,
      stderr: (text) => void (stderr += text),
      stdout: (text) => void (stdout += text),
    },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

async function openEnvironment(cwd: string, commit: string): Promise<Readonly<{ path: string; head: string }>> {
  const run = capture(cwd)
  expect(await runYrdProcess(["bun", "yrd", "env", "open", commit, "--json"], run.io), run.stderr()).toBe(0)
  return JSON.parse(run.stdout()) as { path: string; head: string }
}

type World = Readonly<{ git: Git; work: string }>

async function command(
  cwd: string,
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<Readonly<{ exit: number; stderr: string; stdout: string }>> {
  const child = Bun.spawn([...argv], { cwd, env, stderr: "pipe", stdin: "ignore", stdout: "pipe" })
  const [exit, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  return { exit, stderr, stdout }
}

async function world(setup: string, teardown?: string): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-env-open-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "env-open@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(
    join(work, ".yrd.yml"),
    `setup: ${JSON.stringify(setup)}\n${teardown === undefined ? "" : `teardown: ${JSON.stringify(teardown)}\n`}`,
  )
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "declare environment setup"])
  await git(["push", "--quiet", "origin", "main"])
  return { git, work }
}

async function addMaterializedDependency(w: World): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-env-submodule-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "env-open@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, "READY"), "materialized\n")
  await git(["add", "READY"])
  await git(["commit", "--quiet", "-m", "seed materialized dependency"])
  await git(["push", "--quiet", "origin", "main"])
  await w.git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", remote, "vendor/dependency"])
  await w.git(["commit", "--quiet", "-m", "add materialized dependency"])
  await w.git(["push", "--quiet", "origin", "main"])
}

describe("yrd env open prepares the retained environment", () => {
  it("resolves a configured relative workdir against the repository, not the caller's subdirectory", async () => {
    const w = await world(":")
    await w.git(["config", "yrd.workdir", "relative-state"])
    const nested = join(w.work, "nested")
    mkdirSync(nested)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/yrd.ts")
    const run = await command(nested, [process.execPath, cli, "env", "open", selected, "--json"])
    expect(run, run.stderr).toMatchObject({ exit: 0 })
    const { path } = JSON.parse(run.stdout) as { path: string }
    expect(path.startsWith(join(w.work, "relative-state", "environments") + "/")).toBe(true)
    const listed = await command(nested, [process.execPath, cli, "env", "list", "--json"])
    expect(listed, listed.stderr).toMatchObject({ exit: 0 })
    expect(JSON.parse(listed.stdout)).toMatchObject({ environments: [{ path, head: selected }] })
  })

  // The library materializer cannot prove this process boundary: a plain
  // commit needs no tool, and a required CLI must return a trustworthy result.
  it.each(["plain", "missing", "malformed", "partial", "mismatched"])(
    "honours the git-super boundary when %s",
    async (mode) => {
      const w = await world(":")
      const plain = (await w.git(["rev-parse", "HEAD"])).trim()
      await addMaterializedDependency(w)
      const selected = mode === "plain" ? plain : (await w.git(["rev-parse", "HEAD"])).trim()
      const bin = join(w.work, "fixture-bin")
      mkdirSync(bin)
      const git = Bun.which("git")
      const sh = Bun.which("sh")
      expect(git).not.toBeNull()
      expect(sh).not.toBeNull()
      symlinkSync(git!, join(bin, "git"))
      symlinkSync(sh!, join(bin, "sh"))
      if (mode === "malformed") {
        writeFileSync(join(bin, "git-super"), "#!/bin/sh\nprintf 'not-json\\n'\n")
        chmodSync(join(bin, "git-super"), 0o755)
      } else if (mode === "partial" || mode === "mismatched") {
        // Valid JSON and exit zero are insufficient: the external report must
        // attest this exact path/commit and complete, not partial, success.
        writeFileSync(
          join(bin, "git-super"),
          `#!${process.execPath}\nconsole.log(JSON.stringify({
        state: "updated", partial: ${mode === "partial"},
        path: process.argv[5], requested: process.argv[6],
        commit: ${mode === "mismatched" ? '"0".repeat(40)' : "process.argv[6]"},
        gitmodules: true,
        gitlinks: {considered: 1, borrowed: 1, fetched: 0, absent: 0},
        repositories: [{repository: process.cwd(), state: "updated", refs: []}]
      }))\n`,
        )
        chmodSync(join(bin, "git-super"), 0o755)
      }
      const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/yrd.ts")
      const run = await command(w.work, [process.execPath, cli, "env", "open", selected, "--json"], {
        ...process.env,
        PATH: bin,
      })
      if (mode === "plain") {
        expect(run, run.stderr).toMatchObject({ exit: 0 })
        const { path } = JSON.parse(run.stdout) as { path: string }
        expect(existsSync(join(path, ".gitmodules"))).toBe(false)
        expect((await gitIn(path)(["rev-parse", "HEAD"])).trim()).toBe(plain)
      } else {
        expect(run, run.stderr).toMatchObject({ exit: 2, stdout: "" })
        expect(run.stderr).toContain(mode === "missing" ? "requires git-super" : "malformed git-super")
        const listed = capture(w.work)
        expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
        expect(JSON.parse(listed.stdout())).toEqual({ environments: [] })
      }
    },
  )

  it.each(["branch", "unknown", "blob"])("refuses a %s before creating an environment", async (kind) => {
    const w = await world(":")
    const operand =
      kind === "branch"
        ? "main"
        : kind === "unknown"
          ? "0".repeat(40)
          : (await w.git(["rev-parse", "HEAD:.yrd.yml"])).trim()
    const run = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "open", operand, "--json"], run.io)).toBe(2)
    expect(run.stderr()).toContain(operand)
    expect(run.stdout()).toBe("")
    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
    expect(JSON.parse(listed.stdout())).toEqual({ environments: [] })
  })

  it("opens the exact commit detached and runs that commit's setup", async () => {
    const w = await world("printf 'selected commit\\n' > selected-setup.txt")
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    writeFileSync(join(w.work, ".yrd.yml"), "setup: printf 'newer commit\\n' > selected-setup.txt\n")
    await w.git(["add", ".yrd.yml"])
    await w.git(["commit", "--quiet", "-m", "change setup after selected commit"])
    await w.git(["push", "--quiet", "origin", "main"])
    const current = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    expect((await gitIn(path)(["rev-parse", "HEAD"])).trim()).toBe(selected)
    expect((await gitIn(path)(["branch", "--show-current"])).trim()).toBe("")
    expect(readFileSync(join(path, "selected-setup.txt"), "utf8")).toBe("selected commit\n")
    expect((await w.git(["rev-parse", "HEAD"])).trim()).toBe(current)
  })

  it("runs the target's declared setup after materialization", async () => {
    const w = await world(
      "bun --version >/dev/null && test -f vendor/dependency/READY && printf '%s\\n' \"$YRD_REPO\" > setup-ready.txt",
    )
    await addMaterializedDependency(w)
    const run = capture(w.work)

    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await runYrdProcess(["bun", "yrd", "env", "open", selected], run.io), run.stderr()).toBe(0)

    const bay = run.stdout().trim()
    expect(readFileSync(join(bay, "setup-ready.txt"), "utf8")).toBe(`${bay}\n`)
    expect((await gitIn(bay)(["branch", "--show-current"])).trim()).toBe("")
  })

  it("opens the same exact commit twice without attaching or moving its branch", async () => {
    const w = await world('printf \'%s\\n%s\\n\' "$YRD_BASE_SHA" "$YRD_CANDIDATE_SHA" > setup-tree.txt')
    await w.git(["checkout", "--quiet", "-b", "task/reopened"])
    writeFileSync(join(w.work, "branch.txt"), "branch change\n")
    await w.git(["add", "branch.txt"])
    await w.git(["commit", "--quiet", "-m", "change on retained branch"])
    const candidate = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    writeFileSync(join(w.work, "main.txt"), "target change\n")
    await w.git(["add", "main.txt"])
    await w.git(["commit", "--quiet", "-m", "advance target"])
    await w.git(["push", "--quiet", "origin", "main"])
    const { path: bay } = await openEnvironment(w.work, candidate)
    expect(readFileSync(join(bay, "setup-tree.txt"), "utf8")).toBe(`${candidate}\n${candidate}\n`)

    const { path: reopened } = await openEnvironment(w.work, candidate)
    expect(reopened).not.toBe(bay)
    expect(readFileSync(join(reopened, "setup-tree.txt"), "utf8")).toBe(`${candidate}\n${candidate}\n`)
    expect((await w.git(["rev-parse", "refs/heads/task/reopened"])).trim()).toBe(candidate)
  })

  it("keeps a failed environment and reports its command and output", async () => {
    const command = "printf 'setup exploded\\n' >&2; exit 23"
    const w = await world(command)
    const run = capture(w.work)

    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await runYrdProcess(["bun", "yrd", "env", "open", selected], run.io)).toBe(2)

    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io), listed.stderr()).toBe(0)
    const rows = JSON.parse(listed.stdout()) as { environments: { path: string }[] }
    expect(rows.environments).toHaveLength(1)
    const bay = rows.environments[0]!.path
    expect(run.stdout()).toBe("")
    expect(existsSync(bay)).toBe(true)
    expect(await w.git(["worktree", "list", "--porcelain"])).toContain(bay)
    expect((await gitIn(bay)(["branch", "--show-current"])).trim()).toBe("")
    expect(run.stderr()).toContain(command)
    expect(run.stderr()).toContain("exit 23")
    expect(run.stderr()).toContain("exit 23 is not a verdict")
    expect(run.stderr()).toContain("setup exploded")
    expect(run.stderr()).toContain(bay)
  })
})

describe("yrd env close preserves anything it cannot safely remove", () => {
  it("opens, lists and closes a workdir configured through a symlink", async () => {
    const w = await world(":")
    const actual = join(w.work, "state-actual")
    const alias = join(w.work, "state-alias")
    mkdirSync(actual)
    symlinkSync(actual, alias)
    await w.git(["config", "yrd.workdir", alias])
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const physical = realpathSync(path)
    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
    expect(JSON.parse(listed.stdout())).toMatchObject({ environments: [{ path: physical, head: selected }] })
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)
    expect(JSON.parse(closed.stdout())).toEqual({ closed: physical })
    expect(existsSync(path)).toBe(false)
  })

  it("lists and closes newline-containing paths from a nested caller using the same Git registry", async () => {
    const w = await world(":")
    await w.git(["config", "yrd.workdir", join(w.work, "state\nwith spaces")])
    const nested = join(w.work, "nested")
    mkdirSync(nested)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(nested, selected)
    const listed = capture(nested)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
    expect(JSON.parse(listed.stdout())).toMatchObject({ environments: [{ path, head: selected }] })
    const closed = capture(nested)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", relative(nested, path), "--json"], closed.io),
      closed.stderr(),
    ).toBe(0)
    expect(JSON.parse(closed.stdout())).toEqual({ closed: path })
    expect(existsSync(path)).toBe(false)
  })

  it("refuses dirty submodules even when repository configuration normally hides them", async () => {
    const w = await world(":", "printf touched > ../teardown-ran.txt")
    await addMaterializedDependency(w)
    await w.git(["config", "submodule.vendor/dependency.ignore", "all"])
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const userWork = join(path, "vendor/dependency/READY")
    writeFileSync(userWork, "user edits\n")
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io)).toBe(2)
    expect(closed.stderr()).toContain("dirty")
    expect(readFileSync(userWork, "utf8")).toBe("user edits\n")
    expect(existsSync(join(dirname(path), "teardown-ran.txt"))).toBe(false)
  })

  it.each([false, true])("closes a registered clean environment with declared teardown=%s", async (teardown) => {
    const w = await world(":", teardown ? 'printf "%s\\n" "$YRD_CANDIDATE_SHA" > ../closed.txt' : undefined)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    // Close reads the retained commit, never the caller's edited declaration.
    writeFileSync(join(w.work, ".yrd.yml"), "teardown: exit 23\n")
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)
    expect(JSON.parse(closed.stdout())).toEqual({ closed: path })
    expect(existsSync(path)).toBe(false)
    expect(await w.git(["worktree", "list", "--porcelain", "-z"])).not.toContain(path)
    if (teardown) expect(readFileSync(join(dirname(path), "closed.txt"), "utf8")).toBe(`${selected}\n`)
  })

  it.each(["unknown", "outside", "symlink-outside", "dirty-tracked", "dirty-untracked", "locked"])(
    "refuses %s before running teardown or removing data",
    async (kind) => {
      const w = await world(":", "printf touched > ../teardown-ran.txt")
      const selected = (await w.git(["rev-parse", "HEAD"])).trim()
      const { path } = await openEnvironment(w.work, selected)
      let target = path
      if (kind === "unknown") {
        target = join(dirname(path), "unregistered")
        mkdirSync(target)
      } else if (kind === "outside" || kind === "symlink-outside") {
        const outside = join(w.work, "outside")
        await w.git(["worktree", "add", "--quiet", "--detach", outside, selected])
        target = outside
        if (kind === "symlink-outside") {
          target = join(dirname(path), "escape")
          symlinkSync(outside, target)
        }
      } else if (kind === "dirty-tracked") writeFileSync(join(path, ".yrd.yml"), "local edits\n")
      else if (kind === "dirty-untracked") writeFileSync(join(path, "user-work.txt"), "uncommitted work\n")
      else await w.git(["worktree", "lock", "--reason", "active owner", path])

      const before = await w.git(["worktree", "list", "--porcelain", "-z"])
      const closed = capture(w.work)
      expect(await runYrdProcess(["bun", "yrd", "env", "close", target, "--json"], closed.io)).toBe(2)
      expect(closed.stdout()).toBe("")
      expect(closed.stderr()).toContain(
        kind.startsWith("dirty")
          ? "dirty"
          : kind === "locked"
            ? "locked"
            : kind === "unknown"
              ? "not registered"
              : "outside",
      )
      expect(await w.git(["worktree", "list", "--porcelain", "-z"])).toBe(before)
      expect(existsSync(target)).toBe(true)
      expect(existsSync(join(dirname(path), "teardown-ran.txt"))).toBe(false)
      expect(existsSync(join(w.work, "teardown-ran.txt"))).toBe(false)
    },
  )

  it.each(["fail", "dirty"])("preserves the worktree when teardown ends %s", async (kind) => {
    const w = await world(
      ":",
      kind === "fail" ? "printf 'teardown exploded\\n' >&2; exit 23" : "printf changed > teardown-left.txt",
    )
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path], closed.io)).toBe(2)
    expect(closed.stdout()).toBe("")
    expect(closed.stderr()).toContain(kind === "fail" ? "teardown exploded" : "dirty")
    expect(existsSync(path)).toBe(true)
    expect(await w.git(["worktree", "list", "--porcelain", "-z"])).toContain(path)
    if (kind === "dirty") expect(readFileSync(join(path, "teardown-left.txt"), "utf8")).toBe("changed")
  })
})
