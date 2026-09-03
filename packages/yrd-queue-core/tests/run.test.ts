/**
 * One queue run, end to end, against a real remote and a real check script.
 *
 * Every case asserts on what the plan says a reader can see: the exit code,
 * the target's commits, the change's facts at the remote, and the message the
 * notifier was handed. Nothing internal.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, queueRun, readFacts, submit } from "../src/index.ts"
import type { Git, QueueRunOptions } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{
  git: Git
  work: string
  remote: string
  target: string
  workdir: string
  notifyLog: string
  checkLog: string
  options(check: Readonly<{ exit?: number; sleep?: number; timeoutMs?: number; everywhere?: boolean }>): QueueRunOptions
}>

/** A bare remote with `main`, a clone that submits, and a fake check. */
async function world(): Promise<World> {
  // The scratch root must be a real filesystem the runner can lstat; the OS
  // temp dir is fine for a test, the plan's rule about tmpfs is for real runs.
  const root = mkdtempSync(join(tmpdir(), "yrd-core-run-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const workdir = join(root, "queue")
  const notifyLog = join(root, "notify.log")
  const checkLog = join(root, "check.log")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, "target.txt"), "base\n")
  // The target declares the queue, as every real target does: the merged
  // tree's declaration is a built-in check at merge (ruling D2).
  writeFileSync(join(work, ".yrd.yml"), "remote: origin\n")
  await git(["add", "target.txt", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "base"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  // The check exits FAKE_EXIT only where the change's own file is present, so
  // a failure is the change's; FAKE_EVERYWHERE=1 makes it fail at the target
  // too, which is the inherited case.
  const fakeCheck = join(root, "fake-check.sh")
  writeFileSync(
    fakeCheck,
    [
      "#!/bin/sh",
      'sleep "${FAKE_SLEEP:-0}"',
      `echo "fake-check exit=\${FAKE_EXIT:-0} cwd=$(pwd)" >> "${checkLog}"`,
      'if [ -f one.txt ] || [ "${FAKE_EVERYWHERE:-0}" = 1 ]; then exit "${FAKE_EXIT:-0}"; fi',
      "exit 0",
      "",
    ].join("\n"),
  )
  chmodSync(fakeCheck, 0o755)
  const notifier = join(root, "notify.sh")
  writeFileSync(notifier, `#!/bin/sh\ncat >> "${notifyLog}"\n`)
  chmodSync(notifier, 0o755)
  mkdirSync(workdir, { recursive: true })
  return {
    checkLog,
    git,
    notifyLog,
    options: (check) => ({
      checks: [
        {
          environmentPassthrough: ["FAKE_EXIT", "FAKE_SLEEP", "FAKE_EVERYWHERE"],
          name: "verify",
          run: fakeCheck,
          timeoutMs: check.timeoutMs,
        },
      ],
      configBlob: "test-config",
      env: {
        ...process.env,
        FAKE_EVERYWHERE: check.everywhere === true ? "1" : "0",
        FAKE_EXIT: String(check.exit ?? 0),
        FAKE_SLEEP: String(check.sleep ?? 0),
      },
      notify: notifier,
      owner: "@cto",
      remote: "origin",
      repo: work,
      target: "main",
      workdir,
    }),
    remote,
    target,
    work,
    workdir,
  }
}

async function submitCommit(w: World, branch: string, file: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, file), `${file}\n`)
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", file])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: "main", workItem: "@i/10-yrd/1" })
  return head
}

async function remoteTarget(w: World): Promise<string> {
  return (await w.git(["ls-remote", "--refs", "origin", "refs/heads/main"])).trim().split(/\s+/u)[0] ?? ""
}

function messages(w: World): readonly Record<string, string>[] {
  try {
    return readFileSync(w.notifyLog, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, string>)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

describe("a queue run", () => {
  it("pass: the change is checked, merged, the target moves by one merge commit, and the submitter is told to close their bead", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    const after = await remoteTarget(w)
    expect(after).not.toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "main"])
    const parents = (await w.git(["rev-list", "--parents", "-n", "1", after])).trim().split(/\s+/u).slice(1)
    expect(parents).toEqual([w.target, head])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    const facts = await readFacts(w.git, "task/one", head)
    // checked after the on-submit phase, merged after the on-merge phase, sent last.
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "merged", "sent"])
    const sent = messages(w)
    expect(sent).toHaveLength(1)
    // The record is the notifier's contract, unchanged: its kinds are landed, send-back and yrd-broken.
    expect(sent[0]).toMatchObject({ branch: "task/one", head, kind: "landed", pr: "task/one", recipient: "@dev/2", workItem: "@i/10-yrd/1" })
    expect(sent[0]?.id).toBe(facts[2]?.sha)
    expect(readFileSync(outcome.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).kind)).toEqual(
      expect.arrayContaining(["run", "change", "check", "result", "merge", "message"]),
    )
  })

  it("fail: the target stands still, the change ends failed with the check and a remedy, and the submitter gets it back", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 1 }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "failed", "sent"])
    expect(facts[2]?.trailers).toEqual(
      expect.arrayContaining([
        ["Reason", "verify"],
        ["Fault", "submitter"],
      ]),
    )
    expect(messages(w)[0]).toMatchObject({ code: "verify", disposition: "author", kind: "send-back", recipient: "@dev/2" })
  })

  it("stuck: a check that exits 2 stops the run, bills nobody, and tells the queue owner", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 2 }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "stuck", "sent"])
    expect(messages(w)[0]).toMatchObject({ kind: "yrd-broken", recipient: "@cto" })
  })

  it("inherited: a check that fails at the target too is the target's, so the change is stuck and nobody is billed", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ everywhere: true, exit: 1 }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "stuck", "sent"])
    expect(facts[2]?.trailers).toEqual(expect.arrayContaining([["Reason", "inherited"]]))
    expect(messages(w)[0]).toMatchObject({ kind: "yrd-broken", recipient: "@cto" })
    expect(messages(w)[0]?.text).toMatch(/the target is red, not the change/u)
  })

  it("a check past its bound is stuck, not the submitter's", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ sleep: 3, timeoutMs: 500 }))

    expect(outcome.exitCode).toBe(2)
    expect(messages(w)[0]?.text).toMatch(/ran past its bound/u)
  })

  it("nothing submitted is nothing to do", async () => {
    const w = await world()
    const outcome = await queueRun(w.options({}))
    expect(outcome.exitCode).toBe(0)
    expect(await remoteTarget(w)).toBe(w.target)
    expect(messages(w)).toEqual([])
  })

  it("a failing notifier changes nothing about the change, and the next run sends the same message again", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // The notifier is down: the merge still happens, the sent fact says the
    // delivery failed, and the run is not stuck (ruling D9).
    const down = await queueRun({ ...w.options({ exit: 0 }), notify: "sh -c 'echo notifier down >&2; exit 3'" })
    expect(down.exitCode).toBe(0)
    expect(down.merged).toEqual(["task/one"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    let facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "merged", "sent"])
    expect(facts.at(-1)?.trailers).toEqual(expect.arrayContaining([["State", "merged"], ["Delivery", "failed"]]))
    expect(messages(w)).toEqual([])

    // The notifier is back: the same message, with the merged fact's sha as its id.
    const again = await queueRun(w.options({ exit: 0 }))
    expect(again.exitCode).toBe(0)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "merged", "sent", "sent"])
    expect(facts.at(-1)?.trailers).toEqual(expect.arrayContaining([["Delivery", "notifier"]]))
    const merged = facts.find((fact) => fact.kind === "merged")
    expect(messages(w)).toHaveLength(1)
    expect(messages(w)[0]).toMatchObject({ attempt_id: merged?.sha, kind: "landed", recipient: "@dev/2" })
  })

  it("a head merged outside the queue gets its merged fact, naming the commit that landed it, and its submitter is told", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    // The garage lands it by hand: a merge commit on main, pushed.
    await w.git(["merge", "--quiet", "--no-ff", "--no-edit", "-m", "landed by hand", head])
    const landing = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["push", "--quiet", "origin", "main"])

    const outcome = await queueRun(w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(await remoteTarget(w)).toBe(landing)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "merged", "sent"])
    expect(facts[1]?.trailers).toEqual(expect.arrayContaining([["Merge", landing]]))
    expect(messages(w)[0]).toMatchObject({ kind: "landed", recipient: "@dev/2" })
  })

  it("a checked change is judged again when the target's check config is not the one its checked fact names", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await submitCommit(w, "task/two", "two.txt")

    // One merge per run: task/one lands, task/two stays checked under config A.
    const first = await queueRun({ ...w.options({ exit: 0 }), configBlob: "config-A" })
    expect(first.merged).toEqual(["task/one"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    let facts = await readFacts(w.git, "task/two", second)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked"])
    expect(facts[1]?.trailers).toEqual(expect.arrayContaining([["Config", "config-A"]]))

    // The target's declaration changed: the on-submit checks run again under B
    // before the change lands, and the new checked fact names B.
    const next = await queueRun({ ...w.options({ exit: 0 }), configBlob: "config-B" })
    expect(next.merged).toEqual(["task/two"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    facts = await readFacts(w.git, "task/two", second)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "checked", "merged", "sent"])
    expect(facts[2]?.trailers).toEqual(expect.arrayContaining([["Config", "config-B"]]))
  })
})
