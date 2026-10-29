/**
 * @reach fs-walk <fixture-only: temporary origin and clone>
 * @failure yrd drop --local deletes a never-submitted branch before an event on its chain at origin keeps
 * the tip, or still writes a refs/archive shadow ref (30683).
 * @level l2 (`runYrdProcess` against a real remote and clone)
 * @consumer yrd drop --local custody message and recovery command.
 * Also (30277): a drop run in the superproject for a branch only a component holds reports success while
 * removing nothing; it must name the component, its oid and a command that runs there.
 * Also (31457): origin retirement leaves the store's own refs/remotes/origin/<branch> at the retired tip, so a
 * reader of that store keeps paging on a branch the queue already retired.
 * @testonly none
 */
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it, vi } from "vitest"
import {
  createEventQueue,
  createEventStore,
  readBranchHistory,
  readConfig,
  retireOriginBranch,
  submit,
} from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"
import { workdirOf } from "../src/workdir.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string; stdout(): string }> {
  let stderr = ""
  let stdout = ""
  return {
    io: {
      localBranchProtections: null,
      color: false,
      cwd,
      stderr: (text) => void (stderr += text),
      stdout: (text) => void (stdout += text),
      branchIssue: () => undefined,
    },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

it("30683: a never-submitted branch's dropped event starts its chain at origin and keeps the tip; no archive ref", async () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-local-archive-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(repo, ".yrd.yml"), 'checks:\n  - verify: {run: "true"}\n')
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("fixture lost .yrd.yml")
  await createEventQueue(
    createEventStore(repo, "origin", git.selection),
    "main",
    target,
    config,
    new Date("2020-01-01T00:00:00.000Z"),
  )
  // A lane branch that was never submitted: no change record, no archive row.
  await git(["checkout", "--quiet", "-b", "task/never-submitted"])
  writeFileSync(join(repo, "held.txt"), "held\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "held"])
  const tip = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])

  // 30835: origin retirement cannot count a tip that only the author holds. Explain the local cure without mutation.
  const localRefs = await git(["for-each-ref", "--format=%(refname) %(objectname)"])
  const originRefs = await git(["ls-remote", "origin"])
  const unpublished = capture(repo)
  expect(
    await runYrdProcess(
      ["bun", "yrd", "drop", "task/never-submitted", "--retire", "--tip", tip, "--reason", "retire local work"],
      unpublished.io,
    ),
  ).not.toBe(0)
  expect(unpublished.stderr()).toContain("task/never-submitted: no published branch or change history")
  expect(unpublished.stderr()).toContain("local-only")
  expect(unpublished.stderr()).toContain(`cd '${repo}' && yrd 'drop' 'task/never-submitted' '--local' '--tip' '${tip}'`)
  expect(unpublished.stderr()).not.toContain("Invalid revision range")
  expect(await git(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(localRefs)
  expect(await git(["ls-remote", "origin"])).toBe(originRefs)

  const observed = capture(repo)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", "task/never-submitted", "--local", "--tip", tip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  expect(code, observed.stderr()).toBe(0)
  const report = JSON.parse(observed.stdout()) as {
    removed: { branch: string; archiveRef?: string; recovery?: string }[]
  }
  expect(report.removed).toEqual([expect.objectContaining({ branch: "task/never-submitted" })])
  expect(report.removed[0]?.archiveRef).toBeUndefined()
  // No archive ref anywhere: the dropped event that starts the branch's chain at origin keeps the tip (30683).
  expect((await git(["for-each-ref", "--format=%(refname)", "refs/archive/"])).trim()).toBe("")
  expect((await git(["ls-remote", "origin", "refs/archive/*"])).trim()).toBe("")
  const { history } = await readBranchHistory(
    createEventStore(repo, "origin", git.selection),
    "main",
    "task/never-submitted",
  )
  expect(history?.state).toMatchObject({ status: "cancelled", reason: "dropped", commit: tip })
  expect(history?.events.at(-1)?.links).toContain(tip)
  expect((await git(["for-each-ref", "refs/heads/task/never-submitted"])).trim()).toBe("")
  // The recovery command reads the tip back from that chain.
  expect(report.removed[0]?.recovery).toContain("refs/yrd/main/changes/task/never-submitted")
  expect(report.removed[0]?.recovery).toContain(tip)
  // An absent origin branch with completed-drop history is a successful retry, not unpublished work.
  const repeated = capture(repo)
  expect(
    await runYrdProcess(
      ["bun", "yrd", "drop", "task/never-submitted", "--retire", "--tip", tip, "--reason", "repeat completed drop"],
      repeated.io,
    ),
    repeated.stderr(),
  ).toBe(0)
})

// 31457: origin retirement publishes through the Gitomic backend, not `git push`, so git never updates the
// store's tracking ref the way `git push --delete` would; dark-work then re-paged on the retired branch's
// stale refs/remotes/origin/ ref (task/29936-hab-plan-exits-4-five-seats at 7ba97ae4, 2026-10-28).
async function publishedBranch(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(repo, ".yrd.yml"), 'checks:\n  - verify: {run: "true"}\n')
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("fixture lost .yrd.yml")
  await createEventQueue(
    createEventStore(repo, "origin", git.selection),
    "main",
    target,
    config,
    new Date("2020-01-01T00:00:00.000Z"),
  )
  await git(["checkout", "--quiet", "-b", "task/published"])
  writeFileSync(join(repo, "held.txt"), "held\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "held"])
  const tip = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "task/published"])
  await git(["checkout", "--quiet", "main"])
  const tracking = "refs/remotes/origin/task/published"
  const trackingHead = async () => (await git(["for-each-ref", "--format=%(objectname)", tracking])).trim()
  // The CLI's event store is Yrd's private replica of this origin: a separate repository from the checkout.
  const replica = async () => {
    const path = join(await workdirOf(git), "repo")
    expect(existsSync(join(path, ".git"))).toBe(true)
    expect(realpathSync(path)).not.toBe(realpathSync(repo))
  }
  return { repo, git, target, tip, tracking, trackingHead, replica }
}

it("31457: origin retirement deletes the store's tracking ref at the retired tip; a retry clears a stale one", async () => {
  const { repo, git, tip, tracking, trackingHead, replica } = await publishedBranch("yrd-drop-retire-tracking-")
  expect(await trackingHead()).toBe(tip)

  const retired = capture(repo)
  expect(
    await runYrdProcess(["bun", "yrd", "drop", "task/published", "--reason", "abandon published work"], retired.io),
    retired.stderr(),
  ).toBe(0)
  await replica()
  expect((await git(["ls-remote", "origin", "refs/heads/task/published"])).trim()).toBe("")
  expect(await trackingHead()).toBe("")

  // A branch retired before this cure keeps its stale tracking ref; the completed-drop retry removes it.
  await git(["update-ref", tracking, tip])
  const repeated = capture(repo)
  expect(
    await runYrdProcess(
      ["bun", "yrd", "drop", "task/published", "--retire", "--tip", tip, "--reason", "repeat completed drop"],
      repeated.io,
    ),
    repeated.stderr(),
  ).toBe(0)
  expect(await trackingHead()).toBe("")
})

it("31457: withdraw deletes the caller's tracking ref at the retired tip", async () => {
  const { repo, git, tip, trackingHead, replica } = await publishedBranch("yrd-withdraw-tracking-")
  await submit(git, "origin", {
    branch: "task/published",
    submitter: "@dev/10",
    target: { branch: "main", remote: "origin" },
  })
  expect(await trackingHead()).toBe(tip)
  const withdrawn = capture(repo)
  expect(
    await runYrdProcess(
      ["bun", "yrd", "withdraw", "task/published", "--reason", "withdraw published work"],
      withdrawn.io,
    ),
    withdrawn.stderr(),
  ).toBe(0)
  expect(withdrawn.stderr()).not.toContain("retirement incomplete")
  await replica()
  expect((await git(["ls-remote", "origin", "refs/heads/task/published"])).trim()).toBe("")
  expect(await trackingHead()).toBe("")
})

it("31457: retireOriginBranch deletes the tracking ref only after its readbacks pass", async () => {
  const { repo, git, tip, trackingHead } = await publishedBranch("yrd-retire-origin-tracking-")
  await git(["push", "--quiet", "origin", `${tip}:refs/heads/main`])
  const store = createEventStore(repo, "origin", git.selection)
  const publish = store.backend.publish
  if (publish === undefined) throw new Error("fixture backend lacks publish")
  const input = {
    branch: "task/published",
    head: tip,
    authority: { kind: "published-main", ref: "refs/heads/main", tip },
  } as const
  // A publish that keeps the branch fails the absent readback: the retirement throws and the tracking ref stays.
  const keeping = {
    ...store.backend,
    publish: ((root, updates, remote) =>
      publish.call(
        store.backend,
        root,
        updates.filter((update) => update.oid !== null),
        remote,
      )) as typeof publish,
  }
  const refused = await retireOriginBranch({ ...store, backend: keeping }, input).then(
    () => "retired",
    (error: unknown) => String(error),
  )
  expect(refused).toContain("removal did not read back absent")
  expect(await trackingHead()).toBe(tip)

  await retireOriginBranch(store, input)
  expect((await git(["ls-remote", "origin", "refs/heads/task/published"])).trim()).toBe("")
  expect(await trackingHead()).toBe("")
})

it("31457: a tracking ref at another oid survives the retirement, named on stderr", async () => {
  const { repo, git, target, tip, tracking, trackingHead } = await publishedBranch("yrd-drop-retire-moved-tracking-")
  await git(["update-ref", tracking, target])
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    const retired = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "drop", "task/published", "--reason", "abandon published work"], retired.io),
      retired.stderr(),
    ).toBe(0)
    expect((await git(["ls-remote", "origin", "refs/heads/task/published"])).trim()).toBe("")
    expect(await trackingHead()).toBe(target)
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      `yrd: kept ${tracking} at ${target}; the retired head was ${tip}`,
    ])
  } finally {
    warn.mockRestore()
  }
})

it("refuses loudly and keeps the branch when origin will not take the dropped event", async () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-local-refuse-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  const hook = join(remote, "hooks", "pre-receive")
  writeFileSync(
    hook,
    "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/yrd/main/changes/task/never-submitted) echo 'this chain is read-only here' >&2; exit 1;; esac; done\nexit 0\n",
  )
  chmodSync(hook, 0o755)
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(repo, ".yrd.yml"), 'checks:\n  - verify: {run: "true"}\n')
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("fixture lost .yrd.yml")
  await createEventQueue(
    createEventStore(repo, "origin", git.selection),
    "main",
    target,
    config,
    new Date("2020-01-01T00:00:00.000Z"),
  )
  await git(["checkout", "--quiet", "-b", "task/never-submitted"])
  writeFileSync(join(repo, "held.txt"), "held\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "held"])
  const tip = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])

  const observed = capture(repo)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", "task/never-submitted", "--local", "--tip", tip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  // The dropped event could not reach origin, so the drop must not claim success or delete the branch.
  expect(code).not.toBe(0)
  expect(observed.stdout() + observed.stderr()).toContain("refs/yrd/main/changes/task/never-submitted")
  expect((await git(["rev-parse", "refs/heads/task/never-submitted"])).trim()).toBe(tip)
  expect((await git(["for-each-ref", "--format=%(refname)", "refs/archive/"])).trim()).toBe("")
})

it("treats an already-gone branch as a no-op success (28385 area 11, ruled 2026-10-19)", async () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-local-gone-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(repo, ".yrd.yml"), 'checks:\n  - verify: {run: "true"}\n')
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("fixture lost .yrd.yml")
  await createEventQueue(
    createEventStore(repo, "origin", git.selection),
    "main",
    target,
    config,
    new Date("2020-01-01T00:00:00.000Z"),
  )

  const observed = capture(repo)
  const code = await runYrdProcess(
    [
      "bun",
      "yrd",
      "drop",
      "task/never-existed",
      "--local",
      "--tip",
      "0000000000000000000000000000000000000000",
      "--submitter",
      "fixture",
      "--json",
    ],
    observed.io,
  )
  // The requested post-condition already holds: a retry must report a no-op, not a failure.
  expect(code, observed.stderr()).toBe(0)
  const report = JSON.parse(observed.stdout()) as { removed: unknown[]; detail?: string }
  expect(report.removed).toEqual([])
  expect(report.detail).toContain("already gone")
})

it("names the component that holds a branch absent in the superproject, and fails (30277)", async () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-local-component-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const childRemote = join(root, "child.git")
  const childSeed = join(root, "child-seed")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", childRemote])
  await seed(["clone", "--quiet", childRemote, childSeed])
  const childSeedGit = gitIn(childSeed)
  await childSeedGit(["config", "user.name", "yrd test"])
  await childSeedGit(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(childSeed, "CHILD.md"), "child\n")
  await childSeedGit(["add", "CHILD.md"])
  await childSeedGit(["commit", "--quiet", "-m", "child"])
  await childSeedGit(["push", "--quiet", "origin", "main"])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(repo, ".yrd.yml"), 'checks:\n  - verify: {run: "true"}\n')
  await git(["add", "."])
  await git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", childRemote, "vendor/child"])
  await git(["commit", "--quiet", "-m", "queue with a component"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("fixture lost .yrd.yml")
  await createEventQueue(
    createEventStore(repo, "origin", git.selection),
    "main",
    target,
    config,
    new Date("2020-01-01T00:00:00.000Z"),
  )
  // The branch lives only in the component checkout, as a component author's branch does.
  const child = gitIn(join(repo, "vendor/child"))
  await child(["config", "user.name", "yrd test"])
  await child(["config", "user.email", "yrd@test.invalid"])
  await child(["checkout", "--quiet", "-b", "task/component-only"])
  writeFileSync(join(repo, "vendor/child", "WORK.md"), "work\n")
  await child(["add", "WORK.md"])
  await child(["commit", "--quiet", "-m", "component work"])
  const tip = (await child(["rev-parse", "HEAD"])).trim()
  await child(["checkout", "--quiet", "--detach"])
  // The work landed on the component's main, so that published main keeps the exact tip (30683).
  await child(["push", "--quiet", "origin", `${tip}:refs/heads/main`])

  const misdirected = capture(repo)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", "task/component-only", "--local", "--tip", tip, "--submitter", "fixture", "--json"],
    misdirected.io,
  )
  expect(code, misdirected.stderr()).toBe(1)
  const report = JSON.parse(misdirected.stdout()) as { removed: unknown[]; components: unknown[]; detail: string }
  expect(report.removed).toEqual([])
  expect(report.components).toEqual([{ path: expect.stringMatching(/\/vendor\/child$/u), oid: tip }])
  expect(report.detail).toContain("refs/heads/task/component-only is absent in ")
  expect(report.detail).toContain(`vendor/child holds refs/heads/task/component-only at ${tip}; retire it there: `)
  expect(report.detail).toContain("resolved its repository from the cwd (30527)")
  expect(report.detail).not.toContain("already gone")
  expect((await child(["rev-parse", "refs/heads/task/component-only"])).trim()).toBe(tip)

  // The checkout's gitfile points into the root's module store; a kept receipt must name that store.
  const staleTip = (await child(["rev-parse", `${tip}^`])).trim()
  const identity = `${realpathSync(join(repo, ".git", "modules", "vendor", "child"))}#refs/heads/task/component-only`
  const keptJSON = capture(join(repo, "vendor/child"))
  const keptArgs = ["bun", "yrd", "drop", "task/component-only", "--local", "--tip", staleTip, "--submitter", "fixture"]
  expect(await runYrdProcess([...keptArgs, "--json"], keptJSON.io)).toBe(1)
  const keptDetail = (JSON.parse(keptJSON.stdout()) as { kept: { detail: string }[] }).kept[0]!.detail
  expect(keptDetail).toContain(identity)
  expect(keptDetail).toMatch(/branch moved|differs from requested tip|advanced/u)
  const keptText = capture(join(repo, "vendor/child"))
  expect(await runYrdProcess(keptArgs, keptText.io)).toBe(1)
  expect(keptText.stdout()).toContain(keptDetail)
  expect((await child(["rev-parse", "refs/heads/task/component-only"])).trim()).toBe(tip)

  // The hint is a cure: the printed command, run as printed in the component, retires the branch its published
  // main keeps, and writes no archive (30683).
  const printed = report.detail.split("retire it there: ")[1]!.split("; this command resolved")[0]!
  const [cd, command] = printed.split(" && ")
  const cwd = [...cd!.matchAll(/'([^']*)'/gu)].map((match) => match[1]!)[0]!
  const argv = [...command!.matchAll(/'([^']*)'/gu)].map((match) => match[1]!)
  expect(command).toBe(`yrd ${argv.map((arg) => `'${arg}'`).join(" ")}`)
  const cure = capture(cwd)
  const cureCode = await runYrdProcess(["bun", "yrd", ...argv], cure.io)
  expect(cureCode, cure.stderr()).toBe(0)
  expect((await child(["for-each-ref", "refs/heads/task/component-only"])).trim()).toBe("")
  expect(await seed(["ls-remote", childRemote, "refs/archive/*"]), cure.stdout()).toBe("")

  // A ref nested under the name is not the named branch: absent everywhere, still the no-op.
  await child(["branch", "task/parent/leaf", tip])
  const nested = capture(repo)
  const nestedCode = await runYrdProcess(
    ["bun", "yrd", "drop", "task/parent", "--local", "--tip", tip, "--submitter", "fixture", "--json"],
    nested.io,
  )
  expect(nestedCode, nested.stderr()).toBe(0)
  expect((JSON.parse(nested.stdout()) as { detail?: string }).detail).toContain("already gone")

  // #31083: a discard with no --reason is kept by the guard, and the human line says why, not only "kept 1".
  await child(["checkout", "--quiet", "-b", "task/discard-me"])
  writeFileSync(join(repo, "vendor/child", "LOSE.md"), "unmerged\n")
  await child(["add", "LOSE.md"])
  await child(["commit", "--quiet", "-m", "unmerged component work"])
  const discardTip = (await child(["rev-parse", "HEAD"])).trim()
  await child(["checkout", "--quiet", "--detach"])
  const reasonless = capture(join(repo, "vendor/child"))
  const reasonlessCode = await runYrdProcess(
    ["bun", "yrd", "drop", "task/discard-me", "--local", "--tip", discardTip, "--discard", "--submitter", "fixture"],
    reasonless.io,
  )
  expect(reasonlessCode, `${reasonless.stderr()}\n${reasonless.stdout()}`).toBe(1)
  expect(reasonless.stdout()).toContain("kept 1")
  expect(reasonless.stdout()).toContain("discard requires an actor and reason")
  expect((await child(["rev-parse", "refs/heads/task/discard-me"])).trim()).toBe(discardTip)

  // Absent in the superproject and in every component: still the ruled idempotent no-op (28385 area 11).
  const absent = capture(repo)
  const absentCode = await runYrdProcess(
    ["bun", "yrd", "drop", "task/nowhere", "--local", "--tip", tip, "--submitter", "fixture", "--json"],
    absent.io,
  )
  expect(absentCode, absent.stderr()).toBe(0)
  expect((JSON.parse(absent.stdout()) as { detail?: string }).detail).toContain("already gone")
}, 60_000)
