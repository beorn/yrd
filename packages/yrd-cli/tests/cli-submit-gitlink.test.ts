/**
 * @failure A pin-only submit can publish an unheld component SHA, build a carrier
 *          from the wrong target, change an unrelated path, or reopen the same
 *          pin under another branch; any of those makes a root pin unsafe.
 * @level   l2 (the public CLI, real bare remotes, real submodules and queue refs)
 * @consumer seats using `yrd submit --gitlink` instead of hand-building a carrier
 * @reach   fs-walk vendor/yrd/packages/yrd-cli/src/**
 * @testonly none
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import { resolveQueueLocation } from "../src/queue-location.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"
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
  await birthEventQueue(work, "main", { localStore: false })

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
  const listed = await yrd(w.work, "list", "--json", "--fresh")
  expect(listed.exitCode, listed.report).toBe(0)
  expect(
    (JSON.parse(listed.stdout) as { changes: readonly { branch: string }[] }).changes.some(
      (row) => row.branch === branch,
    ),
  ).toBe(true)
}

async function raceCarrierCleanup(w: World, branch: string, outcome: "absent" | "moved"): Promise<void> {
  const wrapper = join(w.root, "git-race-cleanup.ts")
  writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bun",
      'import { spawnSync } from "node:child_process"',
      "const args = process.argv.slice(2)",
      'const index = args.indexOf("update-ref")',
      `if (index >= 0 && args[index + 1] === "-d" && args[index + 2] === ${JSON.stringify(`refs/heads/${branch}`)}) {`,
      outcome === "absent"
        ? "  const racing = args"
        : `  const racing = [...args.slice(0, index), "update-ref", args[index + 2], ${JSON.stringify(w.base)}, args[index + 3]]`,
      '  const raced = spawnSync("git", racing, { stdio: "inherit" })',
      "  if (raced.error) throw raced.error",
      '  if (raced.status !== 0) throw new Error("fixture could not race carrier cleanup")',
      "}",
      'const ran = spawnSync("git", args, { stdio: "inherit" })',
      "if (ran.error) throw ran.error",
      "process.exit(ran.status ?? 2)",
      "",
    ].join("\n"),
  )
  chmodSync(wrapper, 0o755)
  await gitIn(w.work)(["config", "--local", "yrd.git", JSON.stringify({ executable: wrapper, contract: "native" })])
}

describe("yrd submit --gitlink builds a queue-owned carrier", () => {
  /** @failure A --gitlink path the queue branch does not carry dies in an internal cwd fault that names neither the path nor the queue, so the author cannot tell a mistyped path from a broken queue.
   * @level l2 @consumer carrier authors whose component path or queue branch is wrong
   */
  it("refuses a --gitlink path the queue carries no store for, by name", async () => {
    const w = await world()
    const one = w.components[0]!
    const ran = await yrd(w.work, "submit", "--gitlink", `vendor/undeclared=${one.held}`, "--issue", "25804", "--json")
    expect(ran.exitCode, ran.report).not.toBe(0)
    // The path is named, and the internal spawn cwd never is.
    expect(ran.stderr).toContain("vendor/undeclared")
    expect(ran.stderr).toContain("no store")
    expect(ran.stderr).not.toContain("cannot run")
    expect(ran.stderr).not.toContain("does not exist")
    expect(await refs(w.remote)).not.toContain("pin/vendor-undeclared")
  }, 90_000)

  /** @failure Local cleanup failure hides a committed submit receipt or deletes a moved ref (26653 AC1, AC2).
   * @level l2 @consumer carrier authors receiving the public CLI receipt
   */
  it.each(["absent", "moved"] as const)(
    "keeps the committed receipt when cleanup finds the ref %s",
    async (outcome) => {
      const w = await world()
      const one = w.components[0]!
      const branch = `pin/vendor-one/${one.held.slice(0, 12)}`
      await raceCarrierCleanup(w, branch, outcome)
      const ran = await yrd(w.work, "submit", "--gitlink", `${one.path}=${one.held}`, "--issue", "25804", "--json")
      expect(ran.exitCode, ran.report).toBe(0)
      const receipt = JSON.parse(ran.stdout) as { branch: string; head: string; opened: string }
      expect(receipt.branch).toBe(branch)
      expect(receipt.head).toBe(await remoteHead(w.remote, branch))
      expect(receipt.opened).toBe((await gitIn(w.remote)(["rev-parse", `refs/yrd/main/changes/${branch}`])).trim())
      const observed = JSON.parse(ran.stdout) as {
        verifying: { gitlinks: { path: string; state: string; recorded: string; to: string }[] }
      }
      const two = w.components[1]!
      expect(observed.verifying.gitlinks.find((row) => row.path === two.path)).toMatchObject({
        state: "raised",
        recorded: two.held,
        to: two.held,
      })
      await assertCarrier(w, branch, [{ path: one.path, sha: one.held }])
      const location = await resolveQueueLocation(w.work, undefined, process.env, "queue")
      const local = await gitIn(location.repo)(["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`])
      expect(local.trim()).toBe(outcome === "absent" ? "" : w.base)
      if (outcome === "moved") {
        expect(ran.stderr).toContain("local carrier ref")
        expect(ran.stderr).toContain("preserved")
        expect(ran.stderr).toContain(w.base)
        expect(ran.stderr).toContain(receipt.head)
      }
    },
    90_000,
  )

  /** @failure Cleanup conflict overwrites the actual submit refusal (26653 AC3).
   * @level l2 @consumer carrier authors distinguishing rejected publication from cleanup
   */
  it("keeps the submit rejection and cleanup conflict together", async () => {
    const w = await world()
    const one = w.components[0]!
    const branch = `pin/vendor-one/${one.held.slice(0, 12)}`
    await raceCarrierCleanup(w, branch, "moved")
    const hook = join(w.remote, "hooks", "pre-receive")
    writeFileSync(hook, '#!/usr/bin/env bun\nprocess.stderr.write("26653 submit rejected\\n")\nprocess.exit(1)\n')
    chmodSync(hook, 0o755)
    const ran = await yrd(w.work, "submit", "--gitlink", `${one.path}=${one.held}`, "--issue", "25804", "--json")
    expect(ran.exitCode, ran.report).toBe(2)
    expect(ran.stderr).toContain("26653 submit rejected")
    expect(ran.stderr).toContain("could not be removed")
    expect(ran.stderr).toContain(w.base)
    expect(ran.stdout).toBe("")
    expect(await refs(w.remote)).not.toContain(branch)
    const location = await resolveQueueLocation(w.work, undefined, process.env, "queue")
    expect((await gitIn(location.repo)(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(w.base)
  }, 90_000)

  /** @failure A maintenance stop arriving after carrier creation leaves an unpublished local branch behind.
   * @level l2 @consumer pin-only submit against a fenced migration
   */
  it("removes only its generated local carrier when maintenance races the second admission", async () => {
    const w = await world()
    const one = w.components[0]!
    const branch = `pin/vendor-one/${one.held.slice(0, 12)}`
    const git = gitIn(w.work)
    const yrdBin = join(import.meta.dirname, "../../../bin/yrd.ts")
    const marker = join(w.root, "maintenance-injected")
    const injectionLog = join(w.root, "maintenance.log")
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
        `    cd '${w.work}' || exit $?`,
        `    bun '${yrdBin}' queue pause --queue main --maintenance '25041 lab cutover' --notify '@chief' --json > '${injectionLog}' 2>&1 || exit $?`,
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
    const observed = JSON.parse(preview.stdout) as {
      verifying: { gitlinks: { path: string; state: string; recorded: string; to: string }[] }
    }
    const two = w.components[1]!
    expect(observed.verifying.gitlinks.find((row) => row.path === two.path)).toMatchObject({
      state: "raised",
      recorded: two.held,
      to: two.held,
    })
    expect((JSON.parse(preview.stdout) as { dryRun: boolean; branch: string }).branch).toBe(
      `pin/vendor-one/${one.held.slice(0, 12)}`,
    )
    expect(await refs(w.remote)).toBe(before)
    const operand = await yrd(w.work, "submit", "task/manual", "--gitlink", pin, "--issue", "25804")
    expect(operand.exitCode, operand.report).toBe(2)
    expect(operand.stderr, operand.report).toContain("omit the branch operand")
    const file = await yrd(w.work, "submit", "--gitlink", pin, "--issue", "25804", "--file", "root.txt")
    expect(file.exitCode, file.report).toBe(2)
    expect(file.stderr, file.report).toContain("unknown option '--file'")
    const ordinary = await yrd(w.work, "submit", "--file", "root.txt")
    expect(ordinary.exitCode, ordinary.report).toBe(2)
    expect(ordinary.stderr, ordinary.report).toContain("unknown option '--file'")
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
      "--submitter",
      "@dev/2",
    )
    expect(ran.exitCode, ran.report).toBe(2)
    expect(ran.stderr, ran.report).toMatch(/unheld|not.*(remote|found)|not fetchable|cannot fetch/iu)
    expect(await refs(w.remote)).toBe(before)
  }, 60_000)

  /** @failure A dry run reports a composition whose recorded component pin no
   *          store holds, so the queue later names an object it can never read
   *          (27747). 27510 keeps it: the preview anchors the child in the store
   *          the row names before the receipt observes custody, so the retained
   *          row carries no custody and the child reads through its anchor. It is
   *          not refused: a refusal fires for every change whose component main
   *          advanced, which is the ordinary case.
   * @level   l2 (the public CLI, real remotes and real submodule stores)
   * @consumer seats whose held submission waits on a readable candidate
   */
  it("keeps the composed child no store held readable through its preview anchor (27747, 27510)", async () => {
    const w = await world()
    const one = w.components[0]!
    const child = gitIn(one.work)
    // The component main moves on, and the change pins a SIBLING of it that is
    // pushed and checked out, so every pre-existing moved-gitlink guard is
    // satisfied. Their divergence is what makes git-super compose a two-parent
    // child — the one pin no authored tree ever held.
    writeFileSync(join(one.work, "main-only.txt"), "main\n")
    await child(["add", "."])
    await child(["commit", "--quiet", "-m", "one: main moves"])
    const main = (await child(["rev-parse", "HEAD"])).trim()
    await child(["push", "--quiet", "origin", "main"])
    await child(["push", "--quiet", "origin", main + ":refs/git-super/pins/" + main])
    await child(["checkout", "--quiet", "-b", "side", one.held])
    // Disjoint files, so the submodule's own merge is CLEAN: a conflicting
    // divergence is already refused by the compose and would prove nothing.
    writeFileSync(join(one.work, "side-only.txt"), "side\n")
    await child(["add", "."])
    await child(["commit", "--quiet", "-m", "one: side moves"])
    const side = (await child(["rev-parse", "HEAD"])).trim()
    await child(["push", "--quiet", "origin", "side"])
    await child(["push", "--quiet", "origin", side + ":refs/git-super/pins/" + side])
    const branch = "task/pin-merged-child"
    const git = gitIn(w.work)
    await git(["checkout", "--quiet", "-b", branch, "main"])
    // The pin is published to the component remote and deliberately NOT fetched
    // into the root's own checkout, so no store under this tree holds it — the
    // "absent locally" shape 27747 was filed for.
    await git(["update-index", "--add", "--cacheinfo", "160000," + side + "," + one.path])
    await git(["commit", "--quiet", "-m", "pin a diverged child\n\nRefs: 25804"])
    const before = await refs(w.remote)
    const ran = await yrd(w.work, "submit", branch, "--issue", "25804", "--dry-run", "--json")
    expect(ran.exitCode, ran.report).toBe(0)
    const receipt = JSON.parse(ran.stdout) as {
      verifying: {
        gitlinks: {
          path: string
          state: string
          from: string
          store?: string
          custody?: { pin: string; state: string; store: string; cure: string }
        }[]
      }
    }
    const row = receipt.verifying.gitlinks.find((candidate) => candidate.path === one.path)
    expect(row).toBeDefined()
    expect(row).toMatchObject({ path: one.path, state: "merged" })
    // The composed child is anchored in the store the row names before the receipt
    // observes custody, so the retained row carries none (@cto 2e3bb32f).
    expect(row?.custody, ran.report).toBeUndefined()
    // The proof, not the prose: that store holds the child at a preview anchor.
    expect(row?.store, ran.report).toBeDefined()
    const anchors = await gitIn(row!.store!)(["for-each-ref", "--format=%(objectname)", "refs/yrd/preview/"])
    expect(anchors.trim().split("\n"), ran.report).toContain(row?.from)
    expect(await refs(w.remote)).toBe(before)
  }, 120_000)

  it("opens a single held pin with exactly one gitlink hunk on the captured main parent", async () => {
    const w = await world()
    const one = w.components[0]!
    const branch = `pin/vendor-one/${one.held.slice(0, 12)}`
    // @failure A real pin submit also runs its unused preview, composing the
    // same carrier twice and repeating its acquisitions (26331).
    // @level l2 @consumer yrd submit --gitlink
    // Observe the real process boundary; every invocation still runs Git Super.
    const bin = join(w.root, "observe-bin")
    mkdirSync(bin)
    const compositions = join(w.root, "compositions.jsonl")
    const wrapper = join(bin, "git-super")
    const previousBin = process.env.YRD_GIT_SUPER_BIN
    expect(previousBin).toBeDefined()
    writeFileSync(
      wrapper,
      [
        `#!${process.execPath}`,
        'import { appendFileSync } from "node:fs"',
        'import { spawnSync } from "node:child_process"',
        "const args = process.argv.slice(2)",
        'if (args[0] === "--json" && args[1] === "merge")',
        `  appendFileSync(${JSON.stringify(compositions)}, JSON.stringify({ head: args[2] }) + "\\n")`,
        `const ran = spawnSync(${JSON.stringify(previousBin)}, args, { stdio: "inherit" })`,
        "if (ran.error) throw ran.error",
        "process.exit(ran.status ?? 1)",
        "",
      ].join("\n"),
    )
    chmodSync(wrapper, 0o755)
    process.env.YRD_GIT_SUPER_BIN = wrapper
    let ran: Awaited<ReturnType<typeof yrd>>
    try {
      ran = await yrd(
        w.work,
        "submit",
        "--gitlink",
        `${one.path}=${one.held}`,
        "--issue",
        "25804",
        "--submitter",
        "@dev/2",
      )
    } finally {
      if (previousBin === undefined) delete process.env.YRD_GIT_SUPER_BIN
      else process.env.YRD_GIT_SUPER_BIN = previousBin
    }
    expect(ran.exitCode, ran.report).toBe(0)
    await assertCarrier(w, branch, [{ path: one.path, sha: one.held }])
    const composed = readFileSync(compositions, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(composed).toEqual([{ head: await remoteHead(w.remote, branch) }])
    const location = await resolveQueueLocation(w.work, undefined, process.env, "queue")
    // Cleanup owns this carrier only; another submit's moved ref must remain intact.
    expect(await gitIn(location.repo)(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`])).toBe("")
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
      "--submitter",
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
      "--submitter",
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
      "--submitter",
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
    const opened = await yrd(w.work, "submit", "task/manual-pin", "--issue", "25804", "--submitter", "@dev/2")
    expect(opened.exitCode, opened.report).toBe(0)

    const before = await refs(w.remote)
    const duplicate = await yrd(
      w.work,
      "submit",
      "--gitlink",
      `${one.path}=${one.held}`,
      "--issue",
      "25804",
      "--submitter",
      "@dev/2",
    )
    expect(duplicate.exitCode, duplicate.report).toBe(2)
    expect(duplicate.stderr, duplicate.report).toContain("task/manual-pin")
    expect(await refs(w.remote)).toBe(before)
  }, 90_000)

  it("refuses an already-open pin when the pin was moved in a multi-commit ordinary change", async () => {
    const w = await world()
    const one = w.components[0]!
    const git = gitIn(w.work)
    await git(["checkout", "--quiet", "-b", "task/multi-commit-pin", "main"])
    const child = gitIn(join(w.work, one.path))
    await child(["fetch", "--quiet", "origin", "main"])
    await child(["checkout", "--quiet", one.held])
    await git(["add", one.path])
    await git(["commit", "--quiet", "-m", "pin one in first commit\n\nRefs: 25804"])
    writeFileSync(join(w.work, "other.txt"), "second commit\n")
    await git(["add", "other.txt"])
    await git(["commit", "--quiet", "-m", "second commit\n\nRefs: 25804"])
    await git(["checkout", "--quiet", "main"])
    const opened = await yrd(w.work, "submit", "task/multi-commit-pin", "--issue", "25804", "--submitter", "@dev/2")
    expect(opened.exitCode, opened.report).toBe(0)

    const before = await refs(w.remote)
    const duplicate = await yrd(
      w.work,
      "submit",
      "--gitlink",
      `${one.path}=${one.held}`,
      "--issue",
      "25804",
      "--submitter",
      "@dev/2",
    )
    expect(duplicate.exitCode, duplicate.report).toBe(2)
    expect(duplicate.stderr, duplicate.report).toContain("task/multi-commit-pin")
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
      "--submitter",
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
    // The event queue deletes the merged carrier branch (26420);
    // main receives the composed tree without rewriting the carrier commit.
    await expect(remoteHead(w.remote, branch)).rejects.toThrow(/refs\/heads\/pin\//u)
    const merged = await remoteHead(w.remote, "main")
    expect(merged).not.toBe(advanced)
    expect((await gitIn(w.remote)(["ls-tree", merged, one.path])).trim()).toBe(
      `160000 commit ${one.unheld}\t${one.path}`,
    )
    expect((await gitIn(join(w.root, "one.git"))(["rev-parse", "refs/heads/main"])).trim()).toBe(one.unheld)
  }, 90_000)
})

describe("ordinary submit with a local-only component pin", () => {
  /** @failure A remotely fetchable commit is reported without a permanent retention ref (27091 AC2).
   * @level l2 @consumer preparation before GitHub archive installation
   */
  // Existing local-only tests cannot reach the fetch-then-retain path.
  it("retains a fetched remote commit that has no pin ref", async () => {
    const w = await world()
    const one = w.components[0]!
    await gitIn(one.work)(["push", "--quiet", "origin", `${one.unheld}:refs/heads/published-without-retention`])
    const git = gitIn(w.work)
    const child = gitIn(join(w.work, one.path))
    await expect(child(["cat-file", "-e", `${one.unheld}^{commit}`])).rejects.toThrow()
    await git(["checkout", "--quiet", "-b", "task/prepare-fetched-pin"])
    await git(["update-index", "--cacheinfo", `160000,${one.unheld},${one.path}`])
    await git(["commit", "--quiet", "-m", "prepare fetched pin\n\nRefs: 27091"])
    const ran = await yrd(w.work, "submit", "--prepare", "--submitter", "@dev/3", "--json")
    expect(ran.exitCode, ran.report).toBe(0)
    const receipt = JSON.parse(ran.stdout) as { published: { state: string; sha: string; path: string }[] }
    expect(receipt.published).toContainEqual(
      expect.objectContaining({ path: one.path, sha: one.unheld, state: "published" }),
    )
    expect((await gitIn(join(w.root, "one.git"))(["rev-parse", `refs/git-super/pins/${one.unheld}`])).trim()).toBe(
      one.unheld,
    )
  }, 90_000)

  /** @failure Preparation moves an immutable ref held by a conflicting winner, or hides its two object IDs (27091 AC4).
   * @level l2 @consumer create-only permanent child retention
   */
  // Identical retries do not exercise an existing destination holding a different object.
  it("refuses a conflicting retention winner and names both commits", async () => {
    const w = await world()
    const one = w.components[0]!
    const git = gitIn(w.work)
    const child = gitIn(join(w.work, one.path))
    await child(["fetch", "--quiet", one.work, one.unheld])
    await child(["checkout", "--quiet", one.unheld])
    const pin = `refs/git-super/pins/${one.unheld}`
    await gitIn(one.work)(["push", "--quiet", "origin", `${one.old}:${pin}`])
    await git(["checkout", "--quiet", "-b", "task/prepare-conflicting-pin"])
    await git(["add", one.path])
    await git(["commit", "--quiet", "-m", "prepare conflicting pin\n\nRefs: 27091"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const refsBefore = await refs(w.remote)
    const ran = await yrd(w.work, "submit", "--prepare", "--submitter", "@dev/3")
    expect(ran.exitCode, ran.report).toBe(2)
    expect(ran.stderr).toContain("never moves")
    expect(ran.stderr).toContain(one.old)
    expect(ran.stderr).toContain(one.unheld)
    expect((await gitIn(join(w.root, "one.git"))(["rev-parse", pin])).trim()).toBe(one.old)
    expect((await git(["rev-parse", "HEAD"])).trim()).toBe(head)
    expect(await refs(w.remote)).toEqual(refsBefore)
  }, 90_000)

  /** @failure A later rejected child publication hides or discards an earlier permanent receipt (27091 AC4).
   * @level l2 @consumer retry after partial preparation
   */
  // A single-child failure cannot demonstrate preserved partial effects.
  it("preserves and reports an earlier child when a later remote refuses", async () => {
    const w = await world()
    const git = gitIn(w.work)
    for (const component of w.components) {
      const child = gitIn(join(w.work, component.path))
      await child(["fetch", "--quiet", component.work, component.unheld])
      await child(["checkout", "--quiet", component.unheld])
    }
    await git(["checkout", "--quiet", "-b", "task/prepare-partial-pins"])
    await git(["add", ...w.components.map((component) => component.path)])
    await git(["commit", "--quiet", "-m", "prepare partial pins\n\nRefs: 27091"])
    const one = w.components[0]!
    const two = w.components[1]!
    const hook = join(w.root, "two.git/hooks/pre-receive")
    writeFileSync(hook, "#!/bin/sh\nexit 1\n")
    chmodSync(hook, 0o755)
    const rootRefs = await refs(w.remote)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const ran = await yrd(w.work, "submit", "--prepare", "--submitter", "@dev/3")
    expect(ran.exitCode, ran.report).toBe(2)
    expect(ran.stderr).toContain(`could not publish ${two.path}@${two.unheld}`)
    expect(ran.stderr).toContain("retained receipts:")
    expect(ran.stderr).toContain(`refs/git-super/pins/${one.unheld}`)
    expect((await gitIn(join(w.root, "one.git"))(["rev-parse", `refs/git-super/pins/${one.unheld}`])).trim()).toBe(
      one.unheld,
    )
    expect(
      await gitIn(join(w.root, "two.git"))([
        "for-each-ref",
        "--format=%(objectname)",
        `refs/git-super/pins/${two.unheld}`,
      ]),
    ).toBe("")
    expect(await refs(w.remote)).toEqual(rootRefs)
    expect((await git(["rev-parse", "HEAD"])).trim()).toBe(head)
  }, 90_000)

  /** @failure A nested moved pin writes through the parent Git seam or remains unretained (27091 AC2/AC3).
   * @level l2 @consumer recursive preparation from each child's own checkout
   */
  // Flat moved children cannot catch a parent-bound process adapter used for a nested child.
  it("retains nested pins through their own checkouts", async () => {
    const w = await world()
    const one = w.components[0]!
    const two = w.components[1]!
    const git = gitIn(w.work)
    const childRoot = join(w.work, one.path)
    const child = gitIn(childRoot)
    await identity(childRoot)
    await child(["submodule", "add", "--quiet", two.remote, "nested"])
    const nested = gitIn(join(childRoot, "nested"))
    await nested(["fetch", "--quiet", two.work, two.unheld])
    await nested(["checkout", "--quiet", two.unheld])
    await child(["add", ".gitmodules", "nested"])
    await child(["commit", "--quiet", "-m", "add local nested pin"])
    const childHead = (await child(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "-b", "task/prepare-nested-pins"])
    await git(["add", one.path])
    await git(["commit", "--quiet", "-m", "prepare nested pins\n\nRefs: 27091"])
    const ran = await yrd(w.work, "submit", "--prepare", "--submitter", "@dev/3", "--json")
    expect(ran.exitCode, ran.report).toBe(0)
    const receipt = JSON.parse(ran.stdout) as { published: { path: string; sha: string; state: string }[] }
    expect(receipt.published).toEqual([
      expect.objectContaining({ path: one.path, sha: childHead, state: "published" }),
      expect.objectContaining({ path: `${one.path}/nested`, sha: two.unheld, state: "published" }),
    ])
    expect((await gitIn(join(w.root, "two.git"))(["rev-parse", `refs/git-super/pins/${two.unheld}`])).trim()).toBe(
      two.unheld,
    )
  }, 90_000)
  /** @failure Authors must open a root change to retain the child needed before lock regeneration (27091).
   * @level l2 @consumer yrd submit --prepare before the author's lock regeneration
   */
  it("prepares a local-only pin without publishing the root branch or opening a change", async () => {
    const w = await world()
    const one = w.components[0]!
    const git = gitIn(w.work)
    const child = gitIn(join(w.work, one.path))
    await child(["fetch", "--quiet", one.work, one.unheld])
    await child(["checkout", "--quiet", one.unheld])
    const branch = "task/prepare-local-only-pin"
    await git(["checkout", "--quiet", "-b", branch, "main"])
    await git(["add", one.path])
    await git(["commit", "--quiet", "-m", "prepare local pin\n\nRefs: 27091"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const rootRefs = await gitIn(w.remote)(["for-each-ref", "--format=%(refname) %(objectname)"])
    const childMain = await remoteHead(join(w.root, "one.git"), "main")

    const ran = await yrd(w.work, "submit", branch, "--prepare", "--issue", "27091", "--submitter", "@dev/3", "--json")
    expect(ran.exitCode, ran.report).toBe(0)
    const receipt = JSON.parse(ran.stdout) as {
      head: string
      published: readonly { path: string; sha: string; state: string }[]
    }
    expect(receipt.head).toBe(head)
    expect(receipt.published).toContainEqual(
      expect.objectContaining({ path: one.path, sha: one.unheld, state: "published" }),
    )
    expect((await gitIn(join(w.root, "one.git"))(["rev-parse", `refs/git-super/pins/${one.unheld}`])).trim()).toBe(
      one.unheld,
    )
    expect(await remoteHead(join(w.root, "one.git"), "main")).toBe(childMain)
    expect(await gitIn(w.remote)(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(rootRefs)
    expect((await git(["rev-parse", "HEAD"])).trim()).toBe(head)
    const retry = await yrd(w.work, "submit", branch, "--prepare", "--submitter", "@dev/3", "--json")
    expect(retry.exitCode, retry.report).toBe(0)
    const retryReceipt = JSON.parse(retry.stdout) as typeof receipt
    expect(retryReceipt.published).toEqual([
      expect.objectContaining({ path: one.path, sha: one.unheld, state: "retained" }),
    ])
    expect(await gitIn(w.remote)(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(rootRefs)
    const submitted = await yrd(w.work, "submit", branch, "--submitter", "@dev/3", "--json")
    expect(submitted.exitCode, submitted.report).toBe(0)
    expect((JSON.parse(submitted.stdout) as typeof receipt).published).toEqual(retryReceipt.published)
    expect(await remoteHead(w.remote, branch)).toBe(head)
  }, 90_000)

  /** @failure Preparation accepts contradictory write/dry-run or carrier-building flags (27091 AC4).
   * @level l2 @consumer yrd submit --prepare
   */
  // The positive preparation path cannot prove incompatible flags refuse before remote writes.
  it.each(["--dry-run", "--gitlink"])(
    "refuses preparation combined with %s before changing refs",
    async (flag) => {
      const w = await world()
      const before = await gitIn(w.remote)(["for-each-ref", "--format=%(refname) %(objectname)"])
      const args = flag === "--gitlink" ? [flag, `${w.components[0]!.path}=${w.components[0]!.held}`] : [flag]
      const ran = await yrd(w.work, "submit", "--prepare", ...args, "--submitter", "@dev/3")
      expect(ran.exitCode, ran.report).toBe(2)
      expect(ran.stderr).toContain("--prepare")
      expect(ran.stderr).toContain(flag)
      expect(await gitIn(w.remote)(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before)
    },
    90_000,
  )

  /** @failure An empty preparation claims work without identifying the inspected branch, head and base (27091 AC2).
   * @level l2 @consumer yrd submit --prepare receipts
   */
  // Child publication tests always have moved pins, so cannot prove the empty receipt's identity.
  it("names the inspected branch, head and base when no gitlink moved", async () => {
    const w = await world()
    const git = gitIn(w.work)
    const branch = "task/prepare-no-gitlinks"
    await git(["checkout", "--quiet", "-b", branch])
    await git(["commit", "--allow-empty", "--quiet", "-m", "prepare no pins\n\nRefs: 27091"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const ran = await yrd(w.work, "submit", branch, "--prepare", "--submitter", "@dev/3", "--json")
    expect(ran.exitCode, ran.report).toBe(0)
    expect(JSON.parse(ran.stdout)).toMatchObject({ branch, head, base: w.base, published: [] })
  }, 90_000)

  /** @failure Submit composes before publishing the component pin, so git-super cannot fetch it.
   * @level l2 @consumer yrd submit of a root carrier with a locally committed component
   */
  it("publishes the pin before composing and opening the root carrier", async () => {
    const w = await world()
    const one = w.components[0]!
    const git = gitIn(w.work)
    const child = gitIn(join(w.work, one.path))
    await child(["fetch", "--quiet", one.work, one.unheld])
    await child(["checkout", "--quiet", one.unheld])
    await git(["checkout", "--quiet", "-b", "task/local-only-pin", "main"])
    await git(["add", one.path])
    await git(["commit", "--quiet", "-m", "pin local component\n\nRefs: 25720"])

    const pinRef = `refs/git-super/pins/${one.unheld}`
    expect(await gitIn(join(w.root, "one.git"))(["for-each-ref", "--format=%(objectname)", pinRef])).toBe("")
    // A fresh composer has only the component remote. Gate git-super's merge on
    // that remote's pin ref, then let the real merge run once it is published.
    const bin = join(w.root, "bin")
    mkdirSync(bin)
    const wrapper = join(bin, "git-super")
    writeFileSync(
      wrapper,
      [
        "#!/usr/bin/env bun",
        'import { spawnSync } from "node:child_process"',
        `const args = process.argv.slice(2)`,
        `if (args.includes("merge")) {`,
        `  const probe = spawnSync("git", ["--git-dir", ${JSON.stringify(join(w.root, "one.git"))}, "show-ref", "--verify", "--quiet", ${JSON.stringify(pinRef)}])`,
        `  if (probe.error) throw probe.error`,
        `  if (probe.status === 1) {`,
        `    console.log(JSON.stringify({ state: "failed", partial: false, detail: { code: "pin-not-published", phase: "compose", message: "component remote lacks ${pinRef}" }, gitlinks: [] }))`,
        `    process.exit(2)`,
        `  }`,
        `  if (probe.status !== 0) throw new Error("component pin probe failed: " + String(probe.status))`,
        `}`,
        `const ran = spawnSync(${JSON.stringify(join(import.meta.dirname, "../../../node_modules/.bin/git-super"))}, args, { stdio: "inherit" })`,
        `if (ran.error) throw ran.error`,
        `process.exit(ran.status ?? 2)`,
      ].join("\n"),
    )
    chmodSync(wrapper, 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}:${previousPath ?? ""}`
    let ran: Awaited<ReturnType<typeof yrd>>
    try {
      ran = await yrd(w.work, "submit", "task/local-only-pin", "--issue", "25720", "--submitter", "@dev/1", "--json")
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
    expect(ran.exitCode, ran.report).toBe(0)
    expect(
      (JSON.parse(ran.stdout) as { published: readonly { path: string; sha: string; state: string }[] }).published,
    ).toContainEqual(expect.objectContaining({ path: one.path, sha: one.unheld, state: "published" }))
    expect((await gitIn(join(w.root, "one.git"))(["rev-parse", pinRef])).trim()).toBe(one.unheld)
    expect(await remoteHead(w.remote, "task/local-only-pin")).toBe((await git(["rev-parse", "HEAD"])).trim())
  }, 90_000)

  /** @failure Dry-run fails with generic exit 2 on unpublished component commits (26754).
   * @level l2 @consumer yrd submit --dry-run with an unpublished local component commit
   */
  it("dry-run models unpublished component commit and verifies composition without pushing (26754)", async () => {
    const w = await world()
    const one = w.components[0]!
    const git = gitIn(w.work)
    const wt = join(w.root, "dev-wt")
    await git(["worktree", "add", "-b", "task/local-only-pin-dry-run", wt, "main"])
    await identity(wt)
    const wtGit = gitIn(wt)
    await wtGit(["submodule", "update", "--init"])
    const child = gitIn(join(wt, one.path))
    await child(["fetch", "--quiet", one.work, one.unheld])
    await child(["checkout", "--quiet", one.unheld])
    await wtGit(["add", one.path])
    await wtGit(["commit", "--quiet", "-m", "pin local component for dry run\n\nRefs: 25720"])

    const pinRef = `refs/git-super/pins/${one.unheld}`
    expect(await gitIn(join(w.root, "one.git"))(["for-each-ref", "--format=%(objectname)", pinRef])).toBe("")

    const ran = await yrd(
      wt,
      "submit",
      "task/local-only-pin-dry-run",
      "--dry-run",
      "--issue",
      "25720",
      "--submitter",
      "@dev/1",
      "--json",
    )
    expect(ran.exitCode, ran.report).toBe(0)
    const receipt = JSON.parse(ran.stdout) as {
      dryRun: boolean
      verifying: {
        state: string
        gitlinks: { path: string; state: string; recorded: string; from: string; to: string }[]
      }
    }
    expect(receipt.dryRun).toBe(true)
    expect(receipt.verifying.state).toBe("verified")
    expect(receipt.verifying.gitlinks.find((row) => row.path === one.path)).toMatchObject({
      state: "kept-ahead",
      recorded: one.unheld,
      from: one.unheld,
      to: one.held,
    })
    expect(await gitIn(join(w.root, "one.git"))(["for-each-ref", "--format=%(objectname)", pinRef])).toBe("")
    expect(await refs(w.remote)).not.toContain("task/local-only-pin-dry-run")
    // 26835: the ordinary action must print the same observed identity as its preview.
    const submitted = await yrd(
      wt,
      "submit",
      "task/local-only-pin-dry-run",
      "--issue",
      "25720",
      "--submitter",
      "@dev/1",
      "--json",
    )
    expect(submitted.exitCode, submitted.report).toBe(0)
    const result = JSON.parse(submitted.stdout) as {
      verifying: { gitlinks: { path: string; state: string; recorded: string; from: string; to: string }[] }
    }
    expect(result.verifying.gitlinks.find((row) => row.path === one.path)).toMatchObject({
      state: "kept-ahead",
      recorded: one.unheld,
      from: one.unheld,
      to: one.held,
    })
  }, 90_000)

  /** @failure A rejected pin publication leaves a generic compose refusal, obscuring the remote and ref.
   * @level l2 @consumer yrd submit when a component remote refuses its retention ref
   */
  it("names a rejected component pin publication before opening a root change", async () => {
    const w = await world()
    const one = w.components[0]!
    const git = gitIn(w.work)
    const child = gitIn(join(w.work, one.path))
    await child(["fetch", "--quiet", one.work, one.unheld])
    await child(["checkout", "--quiet", one.unheld])
    await git(["checkout", "--quiet", "-b", "task/rejected-local-pin", "main"])
    await git(["add", one.path])
    await git(["commit", "--quiet", "-m", "pin rejected component\n\nRefs: 25720"])

    const pinRef = `refs/git-super/pins/${one.unheld}`
    const hook = join(w.root, "one.git", "hooks", "pre-receive")
    writeFileSync(hook, "#!/bin/sh\nexit 1\n")
    chmodSync(hook, 0o755)
    const ran = await yrd(w.work, "submit", "task/rejected-local-pin", "--issue", "25720", "--submitter", "@dev/1")
    expect(ran.exitCode, ran.report).toBe(2)
    expect(ran.stderr, ran.report).toContain(`could not publish ${one.path}@${one.unheld}`)
    expect(ran.stderr, ran.report).toContain(one.remote)
    expect(ran.stderr, ran.report).toContain(pinRef)
    expect(await gitIn(join(w.root, "one.git"))(["for-each-ref", "--format=%(objectname)", pinRef])).toBe("")
    expect(await refs(w.remote)).not.toContain("refs/heads/task/rejected-local-pin")
  }, 90_000)

  /** @failure Dry-run and candidate outputs show the target's component pin or omit component details,
   *          so authors read their own change as lost (27323).
   * @level l2 @consumer yrd submit --dry-run on a component-moving change
   */
  it("prints author head and landing pin for component-moving dry-run (27323)", async () => {
    const w = await world()
    const one = w.components[0]!
    const git = gitIn(w.work)
    const wt = join(w.root, "dev-wt-27323")
    await git(["worktree", "add", "-b", "task/27323-dry-run", wt, "main"])
    await identity(wt)
    const wtGit = gitIn(wt)
    await wtGit(["submodule", "update", "--init"])
    const child = gitIn(join(wt, one.path))
    await child(["fetch", "--quiet", one.work, one.unheld])
    await child(["checkout", "--quiet", one.unheld])
    await wtGit(["add", one.path])
    await wtGit(["commit", "--quiet", "-m", "move component one\n\nRefs: 27323"])

    // 1. Text mode dry-run output
    const ran = await yrd(wt, "submit", "task/27323-dry-run", "--dry-run", "--issue", "27323", "--submitter", "@dev/1")
    expect(ran.exitCode, ran.report).toBe(0)
    expect(ran.stdout, ran.report).toContain(
      `component ${one.path}: author head ${one.unheld.slice(0, 12)}, landing pin ${one.unheld.slice(0, 12)} (lands directly)`,
    )

    // 2. JSON mode dry-run output
    const ranJson = await yrd(
      wt,
      "submit",
      "task/27323-dry-run",
      "--dry-run",
      "--issue",
      "27323",
      "--submitter",
      "@dev/1",
      "--json",
    )
    expect(ranJson.exitCode, ranJson.report).toBe(0)
    const receipt = JSON.parse(ranJson.stdout) as {
      dryRun: boolean
      verifying: {
        gitlinks: { path: string; state: string; authorHead: string; landingPin: string }[]
      }
    }
    expect(receipt.dryRun).toBe(true)
    const row = receipt.verifying.gitlinks.find((r) => r.path === one.path)
    expect(row).toBeDefined()
    expect(row).toMatchObject({
      path: one.path,
      state: "kept-ahead",
      authorHead: one.unheld,
      landingPin: one.unheld,
    })
  }, 90_000)

  /** @failure A dry run that composes a component child names an object no store
   *          retains (27747, 27510) while still reporting the author's head and
   *          landing pin (27323); the child must stay readable through its
   *          preview anchor after the preview exits.
   * @level   l2 @consumer yrd submit --dry-run on a component-moving change
   */
  it("prints author head and landing pin and anchors the composed child for review (27323, 27747, 27510)", async () => {
    const w = await world()
    const one = w.components[0]!
    const rootGit = gitIn(w.work)
    const rootChild = gitIn(join(w.work, one.path))
    await rootChild(["fetch", "--quiet", one.work, one.held])
    await rootChild(["checkout", "--quiet", one.held])
    await rootGit(["add", one.path])
    await rootGit(["commit", "--quiet", "-m", "advance root to held one"])
    await rootGit(["push", "--quiet", "origin", "main"])

    const wt = join(w.root, "dev-wt-merge-27323")
    await rootGit(["worktree", "add", "-b", "task/27323-merged", wt, w.base])
    await identity(wt)
    const wtGit = gitIn(wt)
    await wtGit(["submodule", "update", "--init"])
    const child = gitIn(join(wt, one.path))
    writeFileSync(join(wt, one.path, "alt.txt"), "alt-content\n")
    await child(["add", "alt.txt"])
    await child(["commit", "--quiet", "-m", "alt commit on one"])
    const altHead = (await child(["rev-parse", "HEAD"])).trim()
    await wtGit(["add", one.path])
    await wtGit(["commit", "--quiet", "-m", "pin alt commit on root\n\nRefs: 27323"])
    // 27510 AC3: a preview grows no permanent pin, in the author's module store or at the component's origin.
    const common = (await wtGit(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const pins = async (repository: string): Promise<string> =>
      gitIn(repository)(["for-each-ref", "--format=%(refname)", "refs/git-super/pins/", "refs/yrd/pins/"])
    const pinsBefore = {
      origin: await pins(join(w.root, "one.git")),
      store: await pins(join(common, "modules", one.path)),
    }

    // 1. Text mode dry-run output
    const ran = await yrd(wt, "submit", "task/27323-merged", "--dry-run", "--issue", "27323", "--submitter", "@dev/1")
    expect(ran.exitCode, ran.report).toBe(0)
    expect(ran.stdout, ran.report).toContain(`component ${one.path}: author head ${altHead.slice(0, 12)}, landing pin `)
    expect(ran.stdout, ran.report).toContain("(component merge happens at land)")

    // 2. JSON mode dry-run output
    const ranJson = await yrd(
      wt,
      "submit",
      "task/27323-merged",
      "--dry-run",
      "--issue",
      "27323",
      "--submitter",
      "@dev/1",
      "--json",
    )
    expect(ranJson.exitCode, ranJson.report).toBe(0)
    const receipt = JSON.parse(ranJson.stdout) as {
      dryRun: boolean
      verifying: {
        gitlinks: {
          path: string
          state: string
          authorHead: string
          landingPin: string
          store?: string
          custody?: { pin: string; state: string; store: string; cure: string }
        }[]
      }
    }
    expect(receipt.dryRun).toBe(true)
    const row = receipt.verifying.gitlinks.find((r) => r.path === one.path)
    expect(row).toBeDefined()
    expect(row).toMatchObject({
      path: one.path,
      state: "merged",
      authorHead: altHead,
    })
    expect(row?.landingPin).toBeDefined()
    expect(row?.landingPin).not.toBe(altHead)
    // 27747's custody row exists only while the store it names lacks the composed child; 27510 anchors that child
    // in that store before the receipt observes custody, so the retained row carries none (@cto 2e3bb32f).
    expect(row?.custody, ranJson.report).toBeUndefined()

    // 27510 AC1: after the preview exits and its scratch is gone, the recorded child is read through its custody
    // anchor in THE store the row names (row.store, git-super's durable module store under the common dir; a linked
    // worktree's own checkout store is a different one): resolve refs/yrd/preview/<clone>/<subject>/<candidate-root>.
    expect(row?.store, ranJson.report).toBeDefined()
    const store = gitIn(row!.store!)
    const anchors = (await store(["for-each-ref", "--format=%(refname) %(objectname)", "refs/yrd/preview/"]))
      .trim()
      .split("\n")
      .filter(Boolean)
    const anchored = anchors.find((line) => line.endsWith(` ${row!.landingPin}`))
    expect(anchored, `anchors in ${row!.store}:\n${anchors.join("\n")}`).toBeDefined()
    const anchor = anchored!.split(" ")[0]!
    expect((await store(["rev-parse", "--verify", `${anchor}^{commit}`])).trim()).toBe(row!.landingPin)
    // Both sides of the composed merge, as @dev/3's RED (yrd 7d0df639) asked: the author's alt.txt and the target's one.txt.
    expect(await store(["show", `${anchor}:alt.txt`])).toBe("alt-content\n")
    expect(await store(["show", `${anchor}:one.txt`])).toBe("held\n")
    // The same-named root anchor holds the candidate root, whose gitlink records that child.
    const rootAnchor = (await wtGit(["for-each-ref", "--format=%(refname)", anchor])).trim()
    expect(rootAnchor, `the root store has no ${anchor}`).toBe(anchor)
    expect((await wtGit(["rev-parse", `${anchor}:${one.path}`])).trim()).toBe(row!.landingPin)
    expect({
      origin: await pins(join(w.root, "one.git")),
      store: await pins(join(common, "modules", one.path)),
    }).toEqual(pinsBefore)
  }, 90_000)
})
