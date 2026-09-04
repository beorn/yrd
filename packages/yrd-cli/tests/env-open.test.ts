/**
 * @failure `yrd env open` stopped after Git/submodule materialization, so a
 *          fresh bay ignored the target's declared `setup:` and could not run
 *          its own typecheck without a hand install.
 * @level   l2 (real bare remote and real retained Git worktree)
 * @consumer every seat opening a fresh environment through `yrd env open`
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

type World = Readonly<{ git: Git; work: string }>

async function command(
  cwd: string,
  argv: readonly string[],
): Promise<Readonly<{ exit: number; stderr: string; stdout: string }>> {
  const child = Bun.spawn([...argv], { cwd, stderr: "pipe", stdin: "ignore", stdout: "pipe" })
  const [exit, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  return { exit, stderr, stdout }
}

async function world(setup: string): Promise<World> {
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
  writeFileSync(join(work, ".yrd.yml"), `setup: ${JSON.stringify(setup)}\n`)
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
  it("opens the exact commit detached and runs that commit's setup", async () => {
    const w = await world("printf 'selected commit\\n' > selected-setup.txt")
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    writeFileSync(join(w.work, ".yrd.yml"), "setup: printf 'newer commit\\n' > selected-setup.txt\n")
    await w.git(["add", ".yrd.yml"])
    await w.git(["commit", "--quiet", "-m", "change setup after selected commit"])
    await w.git(["push", "--quiet", "origin", "main"])
    const current = (await w.git(["rev-parse", "HEAD"])).trim()
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", selected, "--json"], run.io), run.stderr()).toBe(0)

    const { path } = JSON.parse(run.stdout()) as { path: string }
    expect((await gitIn(path)(["rev-parse", "HEAD"])).trim()).toBe(selected)
    expect((await gitIn(path)(["branch", "--show-current"])).trim()).toBe("")
    expect(readFileSync(join(path, "selected-setup.txt"), "utf8")).toBe("selected commit\n")
    expect((await w.git(["rev-parse", "HEAD"])).trim()).toBe(current)
  })

  it("runs the target's declared setup after materialization", async () => {
    const w = await world("test -f vendor/dependency/READY && printf '%s\\n' \"$YRD_REPO\" > setup-ready.txt")
    await addMaterializedDependency(w)
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "ready"], run.io), run.stderr()).toBe(0)

    const bay = join(w.work, ".bays", "ready")
    expect(run.stdout().trim()).toBe(bay)
    expect(readFileSync(join(bay, "setup-ready.txt"), "utf8")).toBe(`${bay}\n`)
    expect((await gitIn(bay)(["branch", "--show-current"])).trim()).toBe("task/ready")
  })

  it("opens from clean and makes the declared root typecheck runnable without a hand install", async () => {
    const w = await world("test ! -x node_modules/.bin/fixture-typecheck && bun install --frozen-lockfile")
    const dependency = join(w.work, "fixture-typecheck")
    mkdirSync(dependency)
    writeFileSync(
      join(w.work, "package.json"),
      JSON.stringify({
        name: "clean-bay-typecheck",
        private: true,
        scripts: { typecheck: "fixture-typecheck --noEmit" },
        devDependencies: { "fixture-typecheck": "file:./fixture-typecheck" },
      }),
    )
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({ name: "fixture-typecheck", version: "1.0.0", bin: { "fixture-typecheck": "bin.js" } }),
    )
    writeFileSync(join(dependency, "bin.js"), '#!/usr/bin/env bun\nconsole.log("declared root typecheck ran")\n')
    chmodSync(join(dependency, "bin.js"), 0o755)
    const locked = await command(w.work, ["bun", "install"])
    expect(locked, locked.stderr).toMatchObject({ exit: 0 })
    rmSync(join(w.work, "node_modules"), { force: true, recursive: true })
    expect(existsSync(join(w.work, "node_modules"))).toBe(false)
    await w.git(["add", "package.json", "bun.lock", "fixture-typecheck"])
    await w.git(["commit", "--quiet", "-m", "declare root typecheck dependency"])
    await w.git(["push", "--quiet", "origin", "main"])
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "typecheck-ready"], run.io), run.stderr()).toBe(0)

    const bay = join(w.work, ".bays", "typecheck-ready")
    const typecheck = await command(bay, ["bun", "run", "typecheck"])
    expect(typecheck, typecheck.stderr).toMatchObject({ exit: 0 })
    expect(typecheck.stdout).toContain("declared root typecheck ran")
  })

  it("derives setup's tree from a reopened branch and the current target", async () => {
    const w = await world('printf \'%s\\n%s\\n\' "$YRD_BASE_SHA" "$YRD_CANDIDATE_SHA" > setup-tree.txt')
    const mergeBase = (await w.git(["rev-parse", "HEAD"])).trim()
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
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "reopened"], run.io), run.stderr()).toBe(0)

    const bay = join(w.work, ".bays", "reopened")
    expect(readFileSync(join(bay, "setup-tree.txt"), "utf8")).toBe(`${mergeBase}\n${candidate}\n`)

    await w.git(["worktree", "remove", "--force", bay])
    const reopened = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "reopened"], reopened.io),
      reopened.stderr(),
    ).toBe(0)
    expect(readFileSync(join(bay, "setup-tree.txt"), "utf8")).toBe(`${mergeBase}\n${candidate}\n`)
  })

  it("keeps a failed environment and reports its command and output", async () => {
    const command = "printf 'setup exploded\\n' >&2; exit 23"
    const w = await world(command)
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "broken"], run.io)).toBe(2)

    const bay = join(w.work, ".bays", "broken")
    expect(run.stdout()).toBe("")
    expect(existsSync(bay)).toBe(true)
    expect(await w.git(["worktree", "list", "--porcelain"])).toContain(bay)
    expect((await gitIn(bay)(["branch", "--show-current"])).trim()).toBe("task/broken")
    expect(run.stderr()).toContain(command)
    expect(run.stderr()).toContain("exit 23")
    expect(run.stderr()).toContain("exit 23 is not a verdict")
    expect(run.stderr()).toContain("setup exploded")
    expect(run.stderr()).toContain(bay)
  })
})
