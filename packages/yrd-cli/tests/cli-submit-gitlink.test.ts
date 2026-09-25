/**
 * @failure A pin-only submit can publish an unheld component SHA, build a carrier
 *          from the wrong target, change an unrelated path, or reopen the same
 *          pin under another branch; any of those makes a root pin unsafe.
 * @level   l2 (the public CLI, real bare remotes, real submodules and queue refs)
 * @consumer seats using `yrd submit --gitlink` instead of hand-building a carrier
 * @reach   fs-walk vendor/yrd/packages/yrd-cli/src/**
 * @testonly none
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn } from "@yrd/queue-core"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []
const gitConfigKeys = [
  "GIT_CONFIG_COUNT",
  ...[0, 1, 2, 3].flatMap((index) => [`GIT_CONFIG_KEY_${index}`, `GIT_CONFIG_VALUE_${index}`]),
] as const
const priorGitConfig = new Map(gitConfigKeys.map((key) => [key, process.env[key]]))
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
  for (const key of gitConfigKeys) {
    const prior = priorGitConfig.get(key)
    if (prior === undefined) delete process.env[key]
    else process.env[key] = prior
  }
})

type World = Readonly<{
  root: string
  remote: string
  work: string
  base: string
  components: readonly Readonly<{
    path: string
    remote: string
    work: string
    old: string
    held: string
    unheld: string
  }>[]
}>

async function yrd(
  work: string,
  ...args: string[]
): Promise<
  Readonly<{
    exitCode: YrdCliExitCode
    stdout: string
    stderr: string
    report: string
  }>
> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    color: false,
    cwd: work,
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  }
  const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...args], io)
  return { exitCode, stdout, stderr, report: `yrd ${args.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}` }
}

async function identity(work: string): Promise<void> {
  const git = gitIn(work)
  await git(["config", "user.email", "pin-submit@yrd.test"])
  await git(["config", "user.name", "yrd"])
}

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-pin-submit-"))
  roots.push(root)
  // Git Super's pin admission requires hosted ownership. Transport the hosted
  // identities into this fixture's bare repositories with Git's own rewrite.
  process.env.GIT_CONFIG_COUNT = "4"
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
  process.env.GIT_CONFIG_VALUE_0 = "always"
  for (const [index, name] of ["one", "two", "root"].entries()) {
    process.env[`GIT_CONFIG_KEY_${index + 1}`] = `url.${join(root, `${name}.git`)}.insteadOf`
    process.env[`GIT_CONFIG_VALUE_${index + 1}`] = `https://git-super.test/owned/${name}.git`
  }
  const seed = gitIn(root)
  const components: { path: string; remote: string; work: string; old: string; held: string; unheld: string }[] = []
  for (const name of ["one", "two"]) {
    const remote = join(root, `${name}.git`)
    const work = join(root, `${name}-work`)
    await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
    await seed(["clone", "--quiet", remote, work])
    await identity(work)
    const git = gitIn(work)
    await git(["remote", "set-url", "origin", `https://git-super.test/owned/${name}.git`])
    await git(["checkout", "--quiet", "-b", "main"])
    writeFileSync(join(work, `${name}.txt`), "old\n")
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", `${name}: old`])
    const old = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", "main"])
    await git(["push", "--quiet", "origin", `${old}:refs/git-super/pins/${old}`])
    components.push({
      path: `vendor/${name}`,
      remote: `https://git-super.test/owned/${name}.git`,
      work,
      old,
      held: "",
      unheld: "",
    })
  }

  const remote = join(root, "root.git")
  const work = join(root, "root-work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  await identity(work)
  const git = gitIn(work)
  await git(["remote", "set-url", "origin", "https://git-super.test/owned/root.git"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f .yrd.yml\n")
  writeFileSync(join(work, "root.txt"), "untouched\n")
  for (const component of components) {
    await git(["submodule", "add", "--quiet", component.remote, component.path])
  }
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "root with two components"])
  const base = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "main"])

  // The root still records `old`; each declared component remote holds `held`.
  // `unheld` exists in a local checkout only, so local object presence cannot
  // substitute for the component remote's admission witness.
  for (const component of components) {
    const child = gitIn(component.work)
    writeFileSync(join(component.work, component.path.endsWith("one") ? "one.txt" : "two.txt"), "held\n")
    await child(["commit", "--quiet", "-am", "held"])
    component.held = (await child(["rev-parse", "HEAD"])).trim()
    await child(["push", "--quiet", "origin", "main"])
    await child(["push", "--quiet", "origin", `${component.held}:refs/git-super/pins/${component.held}`])
    writeFileSync(join(component.work, component.path.endsWith("one") ? "one.txt" : "two.txt"), "unheld\n")
    await child(["commit", "--quiet", "-am", "unheld"])
    component.unheld = (await child(["rev-parse", "HEAD"])).trim()
  }
  mkdirSync(join(root, "queue"), { recursive: true })
  return { root, remote, work, base, components }
}

const refs = async (remote: string): Promise<string> =>
  gitIn(remote)(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/pin", "refs/yrd"])

const remoteHead = async (remote: string, branch: string): Promise<string> =>
  (await gitIn(remote)(["rev-parse", `refs/heads/${branch}`])).trim()

async function assertCarrier(
  w: World,
  branch: string,
  pins: readonly Readonly<{ path: string; sha: string }>[],
): Promise<void> {
  const git = gitIn(w.remote)
  const head = await remoteHead(w.remote, branch)
  expect((await git(["rev-list", "--parents", "-n", "1", head])).trim().split(" ")).toEqual([head, w.base])
  expect(
    (await git(["diff-tree", "--no-commit-id", "--name-only", "-r", w.base, head])).trim().split("\n").sort(),
  ).toEqual(pins.map(({ path }) => path).sort())
  for (const { path, sha } of pins) {
    expect((await git(["ls-tree", head, path])).trim()).toBe(`160000 commit ${sha}\t${path}`)
  }
  expect(await git(["show", "-s", "--format=%B", head])).toContain("Refs: 25804")
  const listed = await yrd(w.work, "list", "--json")
  expect(listed.exitCode, listed.report).toBe(0)
  expect(
    (JSON.parse(listed.stdout) as { changes: readonly { branch: string }[] }).changes.some(
      (row) => row.branch === branch,
    ),
  ).toBe(true)
}

describe("yrd submit --gitlink builds a queue-owned carrier", () => {
  /** @failure A maintenance stop arriving after carrier creation leaves an unpublished local branch behind.
   * @level l2 @consumer pin-only submit against a fenced migration
   */
  it("removes only its generated local carrier when maintenance races the second admission", async () => {
    const w = await world()
    const one = w.components[0]!
    const branch = `pin/vendor-one/${one.held.slice(0, 12)}`
    const git = gitIn(w.work)
    const tree = (await git(["mktree"], "")).trim()
    const pause = (
      await git([
        "commit-tree",
        tree,
        "-m",
        "25041 lab cutover\n\nRecord: paused\nPaused-By: @chief\nCause: maintenance\n",
      ])
    ).trim()
    const marker = join(w.root, "maintenance-injected")
    const wrapper = join(w.root, "git-inject-maintenance.sh")
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        'git "$@"',
        "result=$?",
        `case " $* " in *" update-ref refs/heads/${branch} "*)`,
        `  if [ "$result" -eq 0 ] && [ ! -f '${marker}' ]; then`,
        `    : > '${marker}'`,
        `    git -C '${w.work}' push --quiet origin '${pause}:refs/yrd/main/pause' || exit $?`,
        "  fi ;;",
        "esac",
        'exit "$result"',
        "",
      ].join("\n"),
    )
    chmodSync(wrapper, 0o755)
    await git(["config", "--local", "yrd.git", JSON.stringify({ executable: wrapper, contract: "native" })])
    const refused = await yrd(w.work, "submit", "--gitlink", `${one.path}=${one.held}`, "--issue", "25804")
    expect(refused.exitCode, refused.report).toBe(2)
    expect(refused.stderr, refused.report).toContain("25041 lab cutover")
    expect(existsSync(marker)).toBe(true)
    expect(await git(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`])).toBe("")
    expect(await refs(w.remote)).not.toContain(`refs/heads/${branch}`)
  }, 90_000)
  it("previews without refs and refuses branch or file input before building", async () => {
    const w = await world()
    const one = w.components[0]
    if (one === undefined) throw new Error("fixture has no first component")
    const pin = `${one.path}=${one.held}`
    const before = await refs(w.remote)
    const preview = await yrd(w.work, "submit", "--gitlink", pin, "--issue", "25804", "--dry-run", "--json")
    expect(preview.exitCode, preview.report).toBe(0)
    expect((JSON.parse(preview.stdout) as { dryRun: boolean; branch: string }).branch).toBe(
      `pin/vendor-one/${one.held.slice(0, 12)}`,
    )
    expect(await refs(w.remote)).toBe(before)
    const operand = await yrd(w.work, "submit", "task/manual", "--gitlink", pin, "--issue", "25804")
    expect(operand.exitCode, operand.report).toBe(2)
    expect(operand.stderr, operand.report).toContain("omit the branch operand")
    const file = await yrd(w.work, "submit", "--gitlink", pin, "--issue", "25804", "--file", "root.txt")
    expect(file.exitCode, file.report).toBe(2)
    expect(file.stderr, file.report).toContain("--file is not supported")
    expect(await refs(w.remote)).toBe(before)
  }, 90_000)

  it("refuses a locally present SHA absent at the declared component remote without publishing any root ref", async () => {
    const w = await world()
    const one = w.components[0]!
    const before = await refs(w.remote)
    const ran = await yrd(
      w.work,
      "submit",
      "--gitlink",
      `${one.path}=${one.unheld}`,
      "--issue",
      "25804",
      "--notify",
      "@dev/2",
    )
    expect(ran.exitCode, ran.report).toBe(2)
    expect(ran.stderr, ran.report).toMatch(/unheld|not.*(remote|found)|not fetchable|cannot fetch/iu)
    expect(await refs(w.remote)).toBe(before)
  }, 60_000)

  it("opens a single held pin with exactly one gitlink hunk on the captured main parent", async () => {
    const w = await world()
    const one = w.components[0]!
    const branch = `pin/vendor-one/${one.held.slice(0, 12)}`
    const ran = await yrd(
      w.work,
      "submit",
      "--gitlink",
      `${one.path}=${one.held}`,
      "--issue",
      "25804",
      "--notify",
      "@dev/2",
    )
    expect(ran.exitCode, ran.report).toBe(0)
    await assertCarrier(w, branch, [{ path: one.path, sha: one.held }])
  }, 60_000)

  it("uses one order-independent multi-pin name, refuses its open identity, then re-cuts an ended identity as -r2", async () => {
    const w = await world()
    const [one, two] = w.components as [World["components"][number], World["components"][number]]
    const pair = [`${one.path}=${one.held}`, `${two.path}=${two.held}`]
    const first = await yrd(
      w.work,
      "submit",
      "--gitlink",
      pair[0]!,
      "--gitlink",
      pair[1]!,
      "--issue",
      "25804",
      "--notify",
      "@dev/2",
      "--json",
    )
    expect(first.exitCode, first.report).toBe(0)
    const branch = (JSON.parse(first.stdout) as { branch: string }).branch
    expect(branch).toMatch(/^pin\/vendor-one\+vendor-two\/[0-9a-f]{12}$/u)
    await assertCarrier(w, branch, [
      { path: one.path, sha: one.held },
      { path: two.path, sha: two.held },
    ])

    const openRefs = await refs(w.remote)
    const open = await yrd(
      w.work,
      "submit",
      "--gitlink",
      pair[1]!,
      "--gitlink",
      pair[0]!,
      "--issue",
      "25804",
      "--notify",
      "@dev/2",
    )
    expect(open.exitCode, open.report).toBe(2)
    expect(open.stderr, open.report).toContain(branch)
    expect(await refs(w.remote)).toBe(openRefs)

    const ended = await yrd(w.work, "withdraw", branch)
    expect(ended.exitCode, ended.report).toBe(0)
    const again = await yrd(
      w.work,
      "submit",
      "--gitlink",
      pair[1]!,
      "--gitlink",
      pair[0]!,
      "--issue",
      "25804",
      "--notify",
      "@dev/2",
      "--json",
    )
    expect(again.exitCode, again.report).toBe(0)
    const nextBranch = (JSON.parse(again.stdout) as { branch: string }).branch
    expect(nextBranch).toBe(`${branch}-r2`)
    await assertCarrier(w, nextBranch, [
      { path: one.path, sha: one.held },
      { path: two.path, sha: two.held },
    ])
  }, 90_000)

  it("refuses an already-open pin even when that pin was submitted under another branch name", async () => {
    const w = await world()
    const one = w.components[0]!
    const git = gitIn(w.work)
    await git(["checkout", "--quiet", "-b", "task/manual-pin", "main"])
    const child = gitIn(join(w.work, one.path))
    await child(["fetch", "--quiet", "origin", "main"])
    await child(["checkout", "--quiet", one.held])
    await git(["add", one.path])
    await git(["commit", "--quiet", "-m", "pin one manually\n\nRefs: 25804"])
    await git(["checkout", "--quiet", "main"])
    const opened = await yrd(w.work, "submit", "task/manual-pin", "--issue", "25804", "--notify", "@dev/2")
    expect(opened.exitCode, opened.report).toBe(0)

    const before = await refs(w.remote)
    const duplicate = await yrd(
      w.work,
      "submit",
      "--gitlink",
      `${one.path}=${one.held}`,
      "--issue",
      "25804",
      "--notify",
      "@dev/2",
    )
    expect(duplicate.exitCode, duplicate.report).toBe(2)
    expect(duplicate.stderr, duplicate.report).toContain("task/manual-pin")
    expect(await refs(w.remote)).toBe(before)
  }, 90_000)

  it("lands an ahead pin after main advances that component without rebuilding the submitted branch", async () => {
    const w = await world()
    const one = w.components[0]
    if (one === undefined) throw new Error("fixture has no first component")
    // The requested commit is held remotely, but component main is only at
    // `held`. Root main starts at `old` and moves to `held` after submission.
    await gitIn(one.work)(["push", "--quiet", "origin", `${one.unheld}:refs/git-super/pins/${one.unheld}`])
    const branch = `pin/vendor-one/${one.unheld.slice(0, 12)}`
    const opened = await yrd(
      w.work,
      "submit",
      "--gitlink",
      `${one.path}=${one.unheld}`,
      "--issue",
      "25804",
      "--notify",
      "@dev/2",
    )
    expect(opened.exitCode, opened.report).toBe(0)
    const carrier = await remoteHead(w.remote, branch)

    const git = gitIn(w.work)
    const child = gitIn(join(w.work, one.path))
    await child(["fetch", "--quiet", "origin", "main"])
    await child(["checkout", "--quiet", one.held])
    await git(["add", one.path])
    await git(["commit", "--quiet", "-m", "main advances one to held"])
    await git(["push", "--quiet", "origin", "main"])
    const advanced = await remoteHead(w.remote, "main")

    const round = await yrd(w.work, "queue", "run", "--json")
    expect(round.exitCode, round.report).toBe(0)
    expect((await gitIn(w.remote)(["rev-list", "--parents", "-n", "1", carrier])).trim()).toBe(`${carrier} ${w.base}`)
    // A successful queue merge retires its branch. Its change record retains
    // the original carrier identity while main receives the composed tree.
    expect(await refs(w.remote)).not.toContain(`refs/heads/${branch} `)
    const merged = await remoteHead(w.remote, "main")
    expect(merged).not.toBe(advanced)
    expect((await gitIn(w.remote)(["ls-tree", merged, one.path])).trim()).toBe(
      `160000 commit ${one.unheld}\t${one.path}`,
    )
    expect((await gitIn(join(w.root, "one.git"))(["rev-parse", "refs/heads/main"])).trim()).toBe(one.unheld)
  }, 90_000)
})
