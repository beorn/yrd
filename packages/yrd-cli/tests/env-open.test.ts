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
import { gitIn, type Git } from "@yrd/queue-core"
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
