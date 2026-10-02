/**
 * @failure `yrd env open` stopped after Git/submodule materialization, so a
 *          fresh bay ignored the target's declared `setup:` and could not run
 *          its own typecheck without a hand install.
 *          Existing issue branches were refused without checking Git worktree
 *          occupancy; remote-only branches were silently replaced by the base.
 * @level   l2 (real bare remote and real retained Git worktree)
 * @consumer every seat opening a fresh environment through `yrd env open`
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createEventQueue, createEventStore, readConfig, type Git } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
  delete process.env.HH_WORKTREE_HOME
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

function isolateHome(work: string): string {
  const home = join(work, ".bays")
  process.env.HH_WORKTREE_HOME = home
  return home
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
  isolateHome(work)
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
  /**
   * @failure An older reference calls a target-added submodule removed and advises discarding valid work (26975).
   * @level l2 (real reference history, target gitlink, and env-open materialization)
   * @consumer a caller opening a target whose submodule was added after its reference checkout
   * @testonly none
   */
  it.each(["new path", "replaced file"])(
    "names the adding commit when the reference predates a target submodule (%s)",
    async (pathHistory) => {
      const w = await world(":")
      const beforeAddition = (await w.git(["rev-parse", "HEAD"])).trim()
      if (pathHistory === "replaced file") {
        mkdirSync(join(w.work, "vendor"))
        writeFileSync(join(w.work, "vendor/dependency"), "previous file\n")
        await w.git(["add", "vendor/dependency"])
        await w.git(["commit", "--quiet", "-m", "add file before submodule"])
        await w.git(["rm", "--quiet", "vendor/dependency"])
      }
      await addMaterializedDependency(w)
      const addingCommit = (await w.git(["rev-parse", "HEAD"])).trim()
      const reference = join(w.work, "..", "older-reference")
      await w.git(["clone", "--quiet", w.work, reference])
      await gitIn(reference)(["checkout", "--quiet", "--detach", beforeAddition])
      isolateHome(reference)
      const run = capture(reference)

      expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "future-module"], run.io)).not.toBe(0)

      expect(run.stderr()).toMatch(/reference.*predates.*add/isu)
      expect(run.stderr()).toContain("vendor/dependency")
      expect(run.stderr()).toContain(addingCommit.slice(0, 7))
      expect(run.stderr()).toMatch(/retry.*reference.*at or after/isu)
      expect(run.stderr()).not.toContain("was removed")
      expect(run.stderr()).not.toMatch(/re-author/iu)
      expect(existsSync(join(reference, ".bays", "future-module"))).toBe(false)
    },
  )

  // A bead nested under another opens task/<parent>/<leaf> beside task/<parent>, and git stores a branch as a path,
  // so the raw refusal named neither cause nor way out (@dev/fixer, 25850 beside 25843, 2026-09-25).
  it("refuses a branch beneath an existing branch and names --bay", async () => {
    const w = await world(":")
    await w.git(["branch", "task/parent"])
    const run = capture(w.work)

    expect(
      await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "parent/child", "--issue", "parent/child"], run.io),
    ).not.toBe(0)

    expect(run.stderr()).toContain("task/parent/child")
    expect(run.stderr()).toContain("task/parent")
    expect(run.stderr()).toContain("--bay <name> --issue parent/child")
    expect(existsSync(join(w.work, ".bays", "parent/child"))).toBe(false)
  })

  /**
   * @failure A child issue's implicit branch was nested below its parent's remote branch, so its first submit failed.
   * @level l2 (real remote, worktree, and queue submission)
   * @consumer a seat opening and submitting a child issue without a manual branch rename
   */
  it("opens a child on a flat branch and submits beside its remote-only parent branch", async () => {
    const w = await world(":")
    const target = (await w.git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(w.git, target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("test target lost .yrd.yml")
    await createEventQueue(
      createEventStore(w.work, "origin", gitIn(w.work).selection),
      "main",
      target,
      config,
      new Date(),
    )
    await w.git(["push", "--quiet", "origin", "HEAD:refs/heads/task/parent"])
    expect((await w.git(["for-each-ref", "--format=%(refname)", "refs/heads/task/parent"])).trim()).toBe("")

    const opened = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "open", "--issue", "parent/child", "--json"], opened.io),
      opened.stderr(),
    ).toBe(0)
    const bay = join(w.work, ".bays", "child")
    expect(JSON.parse(opened.stdout())).toMatchObject({ path: bay, branch: "task/child" })
    expect((await gitIn(bay)(["log", "-1", "--format=%(trailers:key=Refs,valueonly)"])).trim()).toBe("parent/child")

    const submitted = capture(bay)
    expect(
      await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], submitted.io),
      submitted.stderr(),
    ).toBe(0)
    expect((await w.git(["ls-remote", "--heads", "origin", "refs/heads/task/child"])).trim()).toContain(
      "refs/heads/task/child",
    )
  })

  it.each(["local", "remote"])(
    "adopts an existing %s nested issue branch before choosing a flat name",
    async (source) => {
      const w = await world(":")
      await w.git(["checkout", "--quiet", "-b", "task/parent/child"])
      writeFileSync(join(w.work, "retained.txt"), "keep nested work\n")
      await w.git(["add", "retained.txt"])
      await w.git(["commit", "--quiet", "-m", "nested issue work\n\nRefs: parent/child"])
      if (source === "remote") await w.git(["push", "--quiet", "origin", "task/parent/child"])
      await w.git(["checkout", "--quiet", "main"])
      const cwd = source === "local" ? w.work : join(w.work, "..", "nested-resumer")
      if (source === "remote") {
        const remote = (await w.git(["remote", "get-url", "origin"])).trim()
        await w.git(["clone", "--quiet", "--branch", "main", "--single-branch", remote, cwd])
        await gitIn(cwd)(["config", "user.email", "env-open@yrd.test"])
        await gitIn(cwd)(["config", "user.name", "yrd"])
      }
      const run = capture(cwd)
      expect(
        await runYrdProcess(["bun", "yrd", "env", "open", "--issue", "parent/child", "--json"], run.io),
        run.stderr(),
      ).toBe(0)
      expect(JSON.parse(run.stdout())).toMatchObject({ branch: "task/parent/child" })
      const bay = join(isolateHome(w.work), "parent/child")
      expect(readFileSync(join(bay, "retained.txt"), "utf8")).toBe("keep nested work\n")
      expect((await w.git(["for-each-ref", "--format=%(refname)", "refs/heads/task/child"])).trim()).toBe("")
    },
  )

  it("names the holder and --bay when two issues share a flat leaf", async () => {
    const w = await world("touch setup-ran.txt")
    await w.git(["checkout", "--quiet", "-b", "task/child"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "bind other child\n\nRefs: other/child"])
    await w.git(["checkout", "--quiet", "main"])
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--issue", "parent/child"], run.io)).toBe(2)
    expect(run.stderr()).toContain("parent/child")
    expect(run.stderr()).toContain("other/child")
    expect(run.stderr()).toContain("--bay <name>")
    expect(existsSync(join(w.work, ".bays", "child", "setup-ran.txt"))).toBe(false)
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

  it.each(["--bay", "--issue"])("%s preserves a reopened branch and derives setup's tree", async (selector) => {
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

    expect(await runYrdProcess(["bun", "yrd", "env", "open", selector, "reopened"], run.io), run.stderr()).toBe(0)

    const bay = join(w.work, ".bays", "reopened")
    const openedGit = gitIn(bay)
    const opened = (await openedGit(["rev-parse", "HEAD"])).trim()
    if (selector === "--issue") {
      expect((await openedGit(["rev-parse", "HEAD^"])).trim()).toBe(candidate)
      expect((await openedGit(["rev-parse", "HEAD^{tree}"])).trim()).toBe(
        (await w.git(["rev-parse", `${candidate}^{tree}`])).trim(),
      )
      expect(await openedGit(["log", "-1", "--format=%B"])).toContain("Refs: reopened")
    } else expect(opened).toBe(candidate)
    expect(readFileSync(join(bay, "setup-tree.txt"), "utf8")).toBe(`${mergeBase}\n${opened}\n`)

    await w.git(["worktree", "remove", "--force", bay])
    const reopened = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "open", selector, "reopened"], reopened.io),
      reopened.stderr(),
    ).toBe(0)
    expect((await gitIn(bay)(["rev-parse", "HEAD"])).trim()).toBe(opened)
    expect(readFileSync(join(bay, "setup-tree.txt"), "utf8")).toBe(`${mergeBase}\n${opened}\n`)
  })

  it("binds a fresh issue before setup and reports the exact binding head", async () => {
    const w = await world("printf '%s\\n' \"$YRD_CANDIDATE_SHA\" > setup-head.txt")
    const before = (await w.git(["rev-parse", "HEAD"])).trim()
    const tree = (await w.git(["rev-parse", "HEAD^{tree}"])).trim()
    const run = capture(w.work)
    const issue = "@i/work/24472-bind-work"

    expect(
      await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "binding", "--issue", issue, "--json"], run.io),
      run.stderr(),
    ).toBe(0)

    const bay = join(w.work, ".bays", "binding")
    const opened = gitIn(bay)
    const head = (await opened(["rev-parse", "HEAD"])).trim()
    expect(head).not.toBe(before)
    expect((await opened(["rev-parse", "HEAD^"])).trim()).toBe(before)
    expect((await opened(["rev-parse", "HEAD^{tree}"])).trim()).toBe(tree)
    expect((await opened(["log", "-1", "--format=%(trailers:key=Refs,valueonly)"])).trim()).toBe(issue)
    expect(JSON.parse(run.stdout())).toMatchObject({ path: bay, head, branch: "task/binding" })
    expect(readFileSync(join(bay, "setup-head.txt"), "utf8")).toBe(`${head}\n`)
  })

  it("writes the target resolver's canonical issue in a fresh binding commit", async () => {
    const w = await world("true")
    writeFileSync(
      join(w.work, ".yrd.yml"),
      `issueResolver: ${JSON.stringify(["sh", "-c", 'printf \'{"id":"@km/storage/%s-full"}\\n\' "$1"', "resolver"])}\n`,
    )
    await w.git(["add", ".yrd.yml"])
    await w.git(["commit", "--quiet", "-m", "declare issue resolver"])
    await w.git(["push", "--quiet", "origin", "main"])
    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "canonical", "--issue", "26050"], run.io),
      run.stderr(),
    ).toBe(0)
    const opened = gitIn(join(w.work, ".bays", "canonical"))
    expect((await opened(["log", "-1", "--format=%(trailers:key=Refs,valueonly)"])).trim()).toBe(
      "@km/storage/26050-full",
    )
  })

  it("refuses a conflicting binding before setup and retains the actual environment", async () => {
    const w = await world("touch setup-ran.txt")
    await w.git(["checkout", "--quiet", "-b", "task/requested"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "bind prior work\n\nRefs: other-issue"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--issue", "requested"], run.io)).toBe(2)

    const bay = join(w.work, ".bays", "requested")
    expect(existsSync(bay)).toBe(true)
    expect((await gitIn(bay)(["rev-parse", "HEAD"])).trim()).toBe(head)
    expect(existsSync(join(bay, "setup-ran.txt"))).toBe(false)
    expect(run.stdout()).toBe("")
    expect(run.stderr()).toContain(bay)
    expect(run.stderr()).toContain("requested")
    expect(run.stderr()).toContain("other-issue")
    expect(run.stderr()).toContain(head)
  })

  it("refuses an issue with a detached commit before provisioning", async () => {
    const w = await world("true")
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    const registrations = await w.git(["worktree", "list", "--porcelain"])
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", head, "--issue", "detached"], run.io)).toBe(2)

    expect(await w.git(["worktree", "list", "--porcelain"])).toBe(registrations)
    expect(run.stderr()).toMatch(/detached.*--issue|--issue.*detached/u)
    expect(run.stdout()).toBe("")
  })

  /**
   * @failure Tracking or remote-only issue branches were refused or replaced by the base, losing retained work.
   * @level l2 (real remote and Git worktree through the CLI)
   * @consumer seats resuming existing branches with `yrd env open --issue` or `--bay`
   */
  it.each([
    { source: "tracking", selector: "--issue" },
    { source: "remote", selector: "--issue" },
    { source: "remote", selector: "--bay" },
  ])("$selector adopts an existing $source branch without dropping its commits", async ({ source, selector }) => {
    const w = await world("true")
    await w.git(["checkout", "--quiet", "-b", "task/resume"])
    writeFileSync(join(w.work, "retained.txt"), "keep this work\n")
    await w.git(["add", "retained.txt"])
    await w.git(["commit", "--quiet", "-m", "work to resume"])
    await w.git(["push", "--quiet", "origin", "task/resume"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    const remote = (await w.git(["remote", "get-url", "origin"])).trim()
    const resumer = join(w.work, "..", "resumer")
    await w.git([
      "clone",
      "--quiet",
      "--branch",
      "main",
      ...(source === "remote" ? ["--single-branch"] : []),
      remote,
      resumer,
    ])
    await gitIn(resumer)(["config", "user.email", "env-open@yrd.test"])
    await gitIn(resumer)(["config", "user.name", "yrd"])
    const run = capture(resumer)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", selector, "resume", "--json"], run.io), run.stderr()).toBe(
      0,
    )

    const path = join(isolateHome(w.work), "resume")
    const opened = (await gitIn(path)(["rev-parse", "HEAD"])).trim()
    expect(JSON.parse(run.stdout())).toMatchObject({ branch: "task/resume", head: opened, path })
    if (selector === "--issue") expect((await gitIn(path)(["rev-parse", "HEAD^"])).trim()).toBe(head)
    else expect(opened).toBe(head)
    expect(readFileSync(join(path, "retained.txt"), "utf8")).toBe("keep this work\n")
  })

  /**
   * @failure Occupied issue branches reported claim provenance instead of their actual Git worktree holder.
   * @level l2 (real occupied Git worktree through the CLI)
   * @consumer seats resolving an occupied branch after `yrd env open --issue` refuses
   */
  it("refuses an occupied branch and names its existing worktree with a supported command", async () => {
    const w = await world("true")
    const occupied = join(w.work, "..", "incumbent")
    await w.git(["worktree", "add", "--quiet", "-b", "task/occupied", occupied])
    const head = (await gitIn(occupied)(["rev-parse", "HEAD"])).trim()
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--issue", "occupied"], run.io), run.stderr()).toBe(2)

    expect(run.stderr()).toContain(occupied)
    expect(run.stderr()).toContain("git worktree list --porcelain")
    expect(run.stderr()).not.toMatch(/claim's draft|bay open/u)
    expect(existsSync(join(w.work, ".bays", "occupied"))).toBe(false)
    expect((await gitIn(occupied)(["rev-parse", "HEAD"])).trim()).toBe(head)
  })

  it("removes a half-made environment whose submodules could not be materialized, and says so (hh 25976)", async () => {
    // A failed materialization left the worktree and its branch behind, so the same open refused next time with
    // "workspace path already exists" and the half-made tree (no submodules, no dependencies) looked usable.
    const w = await world("true")
    await addMaterializedDependency(w)
    // Pin the dependency to a commit no store and no remote has: materialization must fail.
    const missing = "0123456789abcdef0123456789abcdef01234567"
    await w.git(["update-index", "--cacheinfo", `160000,${missing},vendor/dependency`])
    await w.git(["commit", "--quiet", "-m", "pin a commit that exists nowhere"])
    await w.git(["push", "--quiet", "origin", "main"])
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "half-made"], run.io)).not.toBe(0)

    const bay = join(w.work, ".bays", "half-made")
    expect(existsSync(bay), `the half-made bay is removed:\n${run.stderr()}`).toBe(false)
    expect(await w.git(["worktree", "list", "--porcelain"])).not.toContain(bay)
    expect((await w.git(["branch", "--list", "task/half-made"])).trim()).toBe("")
    expect(run.stderr()).toContain("could not open environment 'half-made'")
    expect(run.stderr()).toContain(`removed the half-made environment ${bay}`)
  })

  // The undo removes only what the failed open made. Each guard below protects work from deletion, and without
  // these rows either could be removed with every other row still green (review2 600c75f0, probes 1 and 2).
  it("a failed open of an existing branch keeps the branch and its unpushed commit (hh 25976)", async () => {
    const w = await world("true")
    await addMaterializedDependency(w)
    const missing = "0123456789abcdef0123456789abcdef01234567"
    await w.git(["update-index", "--cacheinfo", `160000,${missing},vendor/dependency`])
    await w.git(["commit", "--quiet", "-m", "pin a commit that exists nowhere"])
    await w.git(["push", "--quiet", "origin", "main"])
    await w.git(["checkout", "--quiet", "-b", "task/kept"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "unpushed work on an existing branch"])
    const kept = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "kept"], run.io)).not.toBe(0)

    const bay = join(w.work, ".bays", "kept")
    expect(existsSync(bay), `the half-made bay is removed:\n${run.stderr()}`).toBe(false)
    expect((await w.git(["rev-parse", "--verify", "refs/heads/task/kept"])).trim(), run.stderr()).toBe(kept)
    expect(run.stderr()).not.toContain("deleted refs/heads/task/kept")
  })

  it("a second open of a live bay is refused and leaves the environment and its uncommitted file (hh 25976)", async () => {
    const w = await world("true")
    const first = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "live"], first.io), first.stderr()).toBe(0)
    const bay = join(w.work, ".bays", "live")
    writeFileSync(join(bay, "uncommitted.txt"), "work in progress\n")
    const second = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "live"], second.io)).not.toBe(0)

    expect(existsSync(join(bay, "uncommitted.txt")), second.stderr()).toBe(true)
    expect(await w.git(["worktree", "list", "--porcelain"])).toContain(bay)
    expect(second.stderr()).not.toContain("removed the half-made environment")
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

  /** @failure 25957: a retained environment could not state that it must outlive idleness.
   * @level l2 @consumer seats holding an environment across sessions
   */
  it("keeps a requested hold when setup fails and shows why close refuses", async () => {
    const w = await world("exit 23")
    const reason = "@dev/5 25957 until review"
    const opened = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "held", "--hold", reason], opened.io)).toBe(2)

    const path = join(w.work, ".bays", "held")
    expect(existsSync(path)).toBe(true)
    expect(await w.git(["worktree", "list", "--porcelain"])).toContain(`locked ${reason}`)

    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
    const heldRows = JSON.parse(listed.stdout()) as { environments: { path: string; hold: string | null }[] }
    expect(heldRows.environments).toContainEqual(expect.objectContaining({ path, hold: reason }))

    const human = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list"], human.io)).toBe(0)
    expect(human.stdout()).toContain(reason)

    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path], closed.io)).toBe(2)
    expect(closed.stderr()).toContain(reason)
    expect(existsSync(path)).toBe(true)
  })

  /** @failure 25957: treating every open as a hold would make scratch environments uncollectable.
   * @level l2 @consumer users of plain yrd env open
   */
  it("leaves a plain open unlocked and lists its hold as null", async () => {
    const w = await world(":")
    const opened = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "scratch"], opened.io)).toBe(0)

    const path = join(w.work, ".bays", "scratch")
    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
    const scratchRows = JSON.parse(listed.stdout()) as { environments: { path: string; hold: string | null }[] }
    expect(scratchRows.environments).toContainEqual(expect.objectContaining({ path, hold: null }))
  })
})

/**
 * @failure The help advertised "open/adopt a branch" beside the usage line
 *          `open [commit]`, so the argument read as accepting a branch. It
 *          never did: a branch is opened with --bay/--issue, and the argument
 *          is an exact commit. A caller who believed the description was
 *          refused and handed `git rev-parse HEAD`, which silently discards
 *          the branch identity they asked for.
 * @level   l2 (real clone, real refs, through the CLI)
 * @consumer anyone reading `yrd env open --help` or hitting its refusal
 */
describe("yrd env open says which input selects which path", () => {
  it("names both spellings in its own help, so the argument cannot be read as a branch", async () => {
    const w = await world("true")
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--help"], run.io), run.stderr()).toBe(0)

    const help = run.stdout()
    // The argument's contract and the branch route are stated as SEPARATE
    // inputs. The bug was one sentence covering both with only one on the
    // usage line.
    expect(help).toMatch(/\[commit\]/u)
    expect(help).toMatch(/--bay/u)
    expect(help).toMatch(/--issue/u)
    // An adopted branch is always task/<name>, which no surface said before.
    expect(help).toContain("task/")
  })

  it("points a branch-shaped argument at --bay/--issue instead of only offering rev-parse", async () => {
    const w = await world("true")
    await w.git(["branch", "task/wanted-branch"])
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "task/wanted-branch"], run.io)).toBe(2)

    const refusal = run.stderr()
    expect(refusal).toContain("task/wanted-branch")
    // The whole defect: the only cure offered was rev-parse, which detaches
    // and throws away the branch the caller named.
    expect(refusal).toMatch(/--bay/u)
    expect(refusal).toMatch(/--issue/u)
    expect(existsSync(join(w.work, ".bays", "task/wanted-branch"))).toBe(false)
  })

  it("still refuses a value that is neither a commit nor a ref, and still names rev-parse", async () => {
    const w = await world("true")
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "not-a-ref-at-all"], run.io)).toBe(2)

    // The negative control: widening the message must not cost the original
    // cure for the case it was written for.
    expect(run.stderr()).toContain("not-a-ref-at-all")
    expect(run.stderr()).toContain("git rev-parse")
  })
})
