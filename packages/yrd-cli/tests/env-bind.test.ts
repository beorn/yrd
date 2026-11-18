/**
 * @failure A dirty environment whose task branch carried no Refs binding could not be preserved or closed:
 *          the only cure was a hand-made empty Refs commit, an invented binding (#34855).
 * @level   l2 (real bare remote and real registered Git worktree)
 * @consumer an owner retiring a dirty environment through `yrd env bind`, then `yrd env close --preserve`
 * @testonly bindBranchToIssue: exported so the write-stage failures (lost CAS, readback after a moved ref) can be driven
 *           through a fault-injecting Git; env open and env bind call it within the module
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { safeRemoveSync } from "removely"
import type { Git } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import { bindBranchToIssue } from "../src/env-commands.ts"
import type { YrdCliIO } from "../src/types.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) safeRemoveSync(root, { within: realpathSync(tmpdir()), allowMissing: true })
  delete process.env.HH_WORKTREE_HOME
})

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string; stdout(): string }> {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      localBranchProtections: null,
      color: false,
      cwd,
      stderr: (text) => void (stderr += text),
      stdout: (text) => void (stdout += text),
    },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

type World = Readonly<{ git: Git; work: string; bay: string; env: Git }>

/** A queue repository with one registered environment on an unbound task branch, carrying dirty work. */
async function world(options: Readonly<{ provider?: string; name?: string }> = {}): Promise<World> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "yrd-cli-env-bind-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "env-bind@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  if (options.provider !== undefined) {
    // The project's issues store, declared the way a real project declares it (30516 fixture shape).
    writeFileSync(join(work, "provider.ts"), options.provider)
    writeFileSync(
      join(work, "issues.yml"),
      `resolve: ${JSON.stringify([process.execPath, "./provider.ts", "<raw>"])}\n`,
    )
    await git(["add", "provider.ts", "issues.yml"])
  }
  writeFileSync(join(work, "tracked.txt"), "one\n")
  writeFileSync(join(work, "staged.txt"), "one\n")
  await git(["add", ".yrd.yml", "tracked.txt", "staged.txt"])
  await git(["commit", "--quiet", "-m", "declare the queue"])
  await git(["push", "--quiet", "origin", "main"])
  const home = join(work, ".bays")
  process.env.HH_WORKTREE_HOME = home
  mkdirSync(home, { recursive: true })
  const name = options.name ?? "held-viewport"
  const bay = join(home, name)
  await git(["worktree", "add", "--quiet", "-b", `task/${name}`, bay, "main"])
  const env = gitIn(bay)
  await env(["config", "user.email", "env-bind@yrd.test"])
  await env(["config", "user.name", "yrd"])
  writeFileSync(join(bay, "work.txt"), "committed but unbound\n")
  await env(["add", "work.txt"])
  await env(["commit", "--quiet", "-m", "unbound work"])
  // The dirty payload a close must keep: staged, unstaged and untracked bytes.
  writeFileSync(join(bay, "staged.txt"), "staged change\n")
  await env(["add", "staged.txt"])
  writeFileSync(join(bay, "tracked.txt"), "unstaged change\n")
  writeFileSync(join(bay, "untracked.txt"), "untracked bytes\n")
  return { git, work, bay, env }
}

/** Every observable the binding must leave alone except the branch head: refs, index, worktree bytes. */
async function snapshot(w: World): Promise<Record<string, string>> {
  return {
    head: (await w.env(["rev-parse", "HEAD"])).trim(),
    // Reading origin's head (the same base read env open makes) refreshes the remote-read cache under
    // refs/gitomic/fetched/; that cache is no branch, binding or custody ref, so it is the one namespace excluded.
    refs: (await w.git(["for-each-ref", "--format=%(refname) %(objectname)"]))
      .split("\n")
      .filter((line) => !line.startsWith("refs/gitomic/fetched/"))
      .join("\n"),
    status: await w.env(["status", "--porcelain=v1", "--untracked-files=all"]),
    cached: await w.env(["diff", "--cached"]),
    unstaged: await w.env(["diff"]),
    staged: readFileSync(join(w.bay, "staged.txt"), "utf8"),
    tracked: readFileSync(join(w.bay, "tracked.txt"), "utf8"),
    untracked: readFileSync(join(w.bay, "untracked.txt"), "utf8"),
  }
}

describe("yrd env bind binds a dirty environment's task branch (#34855)", () => {
  it("--dry-run makes the binding decision and leaves HEAD, refs, index and worktree unchanged", async () => {
    const w = await world()
    const before = await snapshot(w)
    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "bind", w.bay, "--issue", "34645", "--dry-run", "--json"], run.io),
      run.stderr(),
    ).toBe(0)
    expect(JSON.parse(run.stdout())).toMatchObject({
      path: w.bay,
      branch: "task/held-viewport",
      issue: "34645",
      head: before.head,
      wrote: false,
      dryRun: true,
      wouldWrite: true,
    })
    expect(await snapshot(w)).toEqual(before)
  })

  it("writes one bind commit of the head's own tree and keeps staged, unstaged and untracked bytes as they were", async () => {
    const w = await world()
    const before = await snapshot(w)
    const tree = (await w.env(["rev-parse", "HEAD^{tree}"])).trim()
    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "bind", w.bay, "--issue", "34645", "--json"], run.io),
      run.stderr(),
    ).toBe(0)
    const head = (await w.env(["rev-parse", "HEAD"])).trim()
    expect((await w.env(["rev-parse", "HEAD^"])).trim()).toBe(before.head)
    expect((await w.env(["rev-parse", "HEAD^{tree}"])).trim()).toBe(tree)
    expect((await w.env(["log", "-1", "--format=%(trailers:key=Refs,valueonly)"])).trim()).toBe("34645")
    expect((await w.env(["reflog", "-1", "--format=%gs", "task/held-viewport"])).trim()).toBe(
      "yrd env bind: bind 34645",
    )
    expect(JSON.parse(run.stdout())).toEqual({
      path: w.bay,
      branch: "task/held-viewport",
      issue: "34645",
      head,
      previousHead: before.head,
      wrote: true,
      dryRun: false,
      wouldWrite: false,
      bindingCommit: head,
    })
    expect(run.stderr()).toContain("task/held-viewport is bound to 34645 by a yrd env bind Refs commit")
    const after = await snapshot(w)
    expect({ ...after, head: before.head, refs: before.refs }).toEqual(before)
  })

  it("a retry or alias after later commits writes nothing and reports the current head, not the older binding", async () => {
    const w = await world()
    expect(await runYrdProcess(["bun", "yrd", "env", "bind", w.bay, "--issue", "34645"], capture(w.work).io)).toBe(0)
    const bindingCommit = (await w.env(["rev-parse", "HEAD"])).trim()
    await w.env(["commit", "--quiet", "--allow-empty", "-m", "later work on the bound branch"])
    const before = await snapshot(w)
    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "bind", w.bay, "--issue", "34645", "--json"], run.io),
      run.stderr(),
    ).toBe(0)
    const reported = JSON.parse(run.stdout()) as { head: string }
    expect(reported).toMatchObject({ head: before.head, previousHead: before.head, wrote: false, bindingCommit })
    expect(reported.head).not.toBe(bindingCommit)
    expect(await snapshot(w)).toEqual(before)
  })

  it("refuses a different issue on a bound branch with issueOf's words and writes nothing", async () => {
    const w = await world()
    await w.env(["commit", "--quiet", "--allow-empty", "-m", "prior binding\n\nRefs: other-issue"])
    const before = await snapshot(w)
    const run = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "bind", w.bay, "--issue", "34645"], run.io)).toBe(2)
    expect(run.stderr()).toContain("declared issue 34645 conflicts with other-issue")
    expect(run.stdout()).toBe("")
    expect(await snapshot(w)).toEqual(before)
  })

  it("refuses a key the declared issues provider cannot resolve, naming env bind and its path, and writes nothing", async () => {
    const w = await world({
      provider: "console.error('no such issue'); process.exit(1)\n",
    })
    const before = await snapshot(w)
    const run = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "bind", w.bay, "--issue", "missing-key"], run.io)).toBe(2)
    expect(run.stderr()).toContain("yrd env bind: --issue missing-key does not resolve")
    expect(run.stderr()).toContain("no Refs commit was written and task/held-viewport did not move")
    expect(run.stderr()).not.toContain("env open")
    expect(await snapshot(w)).toEqual(before)
  })

  it("refuses a path that is not a registered environment, a detached HEAD, and a missing --issue", async () => {
    const w = await world()
    const outside = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "bind", w.work, "--issue", "34645"], outside.io)).toBe(2)
    expect(outside.stderr()).toContain("nothing was bound")
    await w.env(["switch", "--quiet", "--detach", "HEAD"])
    const detached = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "bind", w.bay, "--issue", "34645"], detached.io)).toBe(2)
    expect(detached.stderr()).toContain("has a detached HEAD")
    const missing = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "bind", w.bay], missing.io)).not.toBe(0)
    expect(missing.stderr()).toContain("--issue")
  })

  it("names bind in its own help, with what it writes", async () => {
    const w = await world()
    const run = capture(w.work)
    await runYrdProcess(["bun", "yrd", "env", "bind", "--help"], run.io)
    const help = run.stdout() + run.stderr()
    expect(help).toContain("yrd env bind [options] <path>")
    expect(help).toContain("--issue <ref>")
    expect(help).toContain("--dry-run")
    expect(help).toContain("staged, unstaged and untracked work and the index stay exactly as")
  })
})

describe("the one binding writer reports each write stage truthfully (#34855)", () => {
  async function bound(w: World): Promise<Readonly<{ head: string; base: string }>> {
    return {
      head: (await w.env(["rev-parse", "HEAD"])).trim(),
      base: (await w.git(["rev-parse", "main"])).trim(),
    }
  }
  const same = async () => ({ same: false, resolved: false, why: "exact comparison" }) as never

  it("a lost CAS says the branch was not moved by this call", async () => {
    const w = await world({ name: "lost-cas" })
    const { head, base } = await bound(w)
    const racing: Git = async (args, ...rest) => {
      if (args[0] === "update-ref") {
        await w.env(["commit", "--quiet", "--allow-empty", "-m", "someone else moved the branch"])
      }
      return w.env(args, ...rest)
    }
    await expect(
      bindBranchToIssue({
        git: racing,
        branch: "task/lost-cas",
        head,
        target: base,
        issue: "34645",
        sameIssue: same,
        verb: "bind",
      }),
    ).rejects.toThrow(/refs\/heads\/task\/lost-cas was not moved by this call/u)
    expect((await w.env(["log", "-1", "--format=%s"])).trim()).toBe("someone else moved the branch")
  })

  it("a successful CAS followed by a changed HEAD read says the binding was already written, never no write", async () => {
    const w = await world({ name: "moved-after" })
    const { head, base } = await bound(w)
    let wrote = false
    const lying: Git = async (args, ...rest) => {
      if (args[0] === "update-ref") wrote = true
      if (wrote && args[0] === "rev-parse" && args[1] === "HEAD") return `${head}\n`
      return w.env(args, ...rest)
    }
    const failure = bindBranchToIssue({
      git: lying,
      branch: "task/moved-after",
      head,
      target: base,
      issue: "34645",
      sameIssue: same,
      verb: "bind",
    })
    await expect(failure).rejects.toThrow(/^binding already written: refs\/heads\/task\/moved-after moved /u)
    await expect(failure).rejects.toThrow(/the branch was not rewound/u)
    await expect(failure).rejects.not.toThrow(/nothing was written|no binding written/u)
    expect((await w.env(["log", "-1", "--format=%(trailers:key=Refs,valueonly)"])).trim()).toBe("34645")
  })

  it("a failed HEAD read after a successful CAS also names the write", async () => {
    const w = await world({ name: "read-failed" })
    const { head, base } = await bound(w)
    let wrote = false
    const failing: Git = async (args, ...rest) => {
      if (args[0] === "update-ref") wrote = true
      if (wrote && args[0] === "rev-parse" && args[1] === "HEAD") throw new Error("simulated read failure")
      return w.env(args, ...rest)
    }
    await expect(
      bindBranchToIssue({
        git: failing,
        branch: "task/read-failed",
        head,
        target: base,
        issue: "34645",
        sameIssue: same,
        verb: "bind",
      }),
    ).rejects.toThrow(/^binding already written: .*reading HEAD afterwards failed: simulated read failure/u)
  })
})
