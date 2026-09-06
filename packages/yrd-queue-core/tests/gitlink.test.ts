/**
 * Product landing settles only authored pins: ahead lands child-first, behind
 * raises, divergent refuses the author, and untouched takes the target's pin.
 * External pins stay as written. An object no remote can supply is the
 * submitter's failed change, never a queue-owned stuck.
 *
 * Measured 2026-09-02 on the old core: a root gitlink pointed at a branch
 * commit forked on the gitlink, and every later change was judged against a
 * component state no main had ever carried. Measured the same day on this
 * core before E4: asking every component of the root's tree cost 15 fetches
 * and 13.7 s per judged change.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createProcess } from "@yrd/process"
import type { Process } from "@yrd/process"
import {
  appendRecord,
  changeRef,
  checksOf,
  directMergeCommits,
  gitIn,
  list,
  queueRun,
  pauseRef,
  readJournals,
  readQueue,
  readRecords,
  submit,
  trailer,
  watchRows,
} from "../src/index.ts"
import type { Git, QueueRunOptions } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{
  git: Git
  work: string
  /** A commit the component's main carries (behind its tip). */
  onMain: string
  /** A commit on a branch of the component that its main does not carry. */
  offMain: string
  /** The newest commit on the component's main when the fixture was made. */
  main: string
  options(check?: Readonly<{ run: string; on: readonly ("submit" | "merge")[] }>): Promise<QueueRunOptions>
}>

/**
 * A component whose main is `one` then `three`, with a branch `feature` at
 * `two` off `one`; a root whose main records the component at `three`.
 */
async function world(landing: "product" | "external" = "product"): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-core-gitlink-"))
  roots.push(root)
  // A component at a local path: git refuses file transport for submodule
  // clones unless every git in the chain is told. Every git runner below and
  // the queue's own git children read this process's environment when they
  // are made, so it is said here, first.
  process.env.GIT_CONFIG_COUNT = "1"
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
  process.env.GIT_CONFIG_VALUE_0 = "always"
  const seed = gitIn(root)
  const identity = async (git: Git): Promise<void> => {
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
  }

  const component = join(root, "component.git")
  const componentWork = join(root, "component-work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", component])
  await seed(["clone", "--quiet", component, componentWork])
  const cg = gitIn(componentWork)
  await identity(cg)
  await cg(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(componentWork, "lib.txt"), "one\n")
  writeFileSync(join(componentWork, ".yrd.yml"), `landing: ${landing}\n`)
  await cg(["add", "lib.txt", ".yrd.yml"])
  await cg(["commit", "--quiet", "-m", "one"])
  const onMain = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["checkout", "--quiet", "-b", "feature"])
  writeFileSync(join(componentWork, "lib.txt"), "two\n")
  await cg(["commit", "--quiet", "-am", "two, not on main"])
  const offMain = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["checkout", "--quiet", "main"])
  writeFileSync(join(componentWork, "lib.txt"), "three\n")
  await cg(["commit", "--quiet", "-am", "three"])
  const main = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["push", "--quiet", "origin", "main", "feature"])

  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await identity(git)
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await git(["submodule", "add", "--quiet", component, "component"])
  await git(["add", ".yrd.yml", ".gitmodules", "component"])
  await git(["commit", "--quiet", "-m", "base, with the component at its main"])
  await git(["push", "--quiet", "origin", "main"])
  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return {
    git,
    main,
    offMain,
    onMain,
    options: async (check) => {
      return {
        checks: check === undefined ? [] : [{ name: "component-check", on: check.on, run: check.run }],
        configBlob: "test-config",
        env: process.env,
        repo: work,
        target: { branch: "main", remote: "origin" },
        targetSha: await remoteTip(git, "refs/heads/main"),
        workdir,
      }
    },
    work,
  }
}

/** A change that moves the component's gitlink to `sha`, submitted. */
async function submitGitlink(w: World, branch: string, sha: string, consumer?: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  const sub = gitIn(join(w.work, "component"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "component"])
  if (consumer !== undefined) {
    writeFileSync(join(w.work, "consumer.txt"), `${consumer}\n`)
    await w.git(["add", "consumer.txt"])
  }
  // The branch is in the message, so two branches recording the same commit in
  // the same second are two heads, not one head under two names.
  await w.git(["commit", "--quiet", "-m", `${branch}: move the component gitlink to ${sha.slice(0, 12)}`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
  return head
}

/** The component's gitlink moved on main itself, around the queue, and pushed: the case candidate settling never sees (E5). */
async function gitlinkAroundQueue(w: World, sha: string): Promise<string> {
  await w.git(["checkout", "--quiet", "main"])
  const sub = gitIn(join(w.work, "component"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "component"])
  await w.git(["commit", "--quiet", "-m", `move the component gitlink to ${sha.slice(0, 12)} around the queue`])
  await w.git(["push", "--quiet", "origin", "main"])
  return (await w.git(["rev-parse", "HEAD"])).trim()
}

/** A change that touches a file and no gitlink, submitted. */
async function submitFile(w: World, branch: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  const file = `${branch.replace(/\//gu, "-")}.txt`
  writeFileSync(join(w.work, file), `${branch}\n`)
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", `${branch}: a file, no gitlink`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
  return head
}

/** Submit a root commit whose gitlink object exists nowhere the queue can fetch. */
async function submitMissingGitlink(w: World, branch: string, missing: string): Promise<string> {
  const base = (await w.git(["rev-parse", "main"])).trim()
  await w.git(["read-tree", "main"])
  await w.git(["update-index", "--add", "--info-only", "--cacheinfo", `160000,${missing},component`])
  const tree = (await w.git(["write-tree"])).trim()
  const head = (
    await w.git(["commit-tree", tree, "-p", base, "-m", `${branch}: record an unavailable component`])
  ).trim()
  await w.git(["update-ref", `refs/heads/${branch}`, head])
  await w.git(["read-tree", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
  return head
}

async function remoteTip(git: Git, ref: string): Promise<string> {
  const tip = (await git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]
  if (tip === undefined || tip === "") throw new Error(`the remote ref ${ref} is absent`)
  return tip
}

async function gitlinkAt(w: World, commit: string): Promise<string> {
  const row = (await w.git(["ls-tree", commit, "--", "component"])).trim().split(/\s+/u)
  return row[2] ?? ""
}

async function advanceComponent(w: World, contents: string): Promise<string> {
  const componentWork = join(w.work, "..", "component-work")
  const component = gitIn(componentWork)
  await component(["checkout", "--quiet", "main"])
  writeFileSync(join(componentWork, "lib.txt"), `${contents}\n`)
  await component(["commit", "--quiet", "-am", contents])
  await component(["push", "--quiet", "origin", "main"])
  return (await component(["rev-parse", "HEAD"])).trim()
}

describe("settling gitlinks", () => {
  // M8.5 K1: the authored component and its root consumer pass together;
  // component main advances before root main. The older fixtures only proved
  // behind pins or divergent pins, never an authored descendant of main.
  it("lands the tested ahead product pin before its root consumer", async () => {
    const w = await world()
    const component = gitIn(join(w.work, "..", "component-work"))
    await component(["checkout", "--quiet", "-b", "ahead", "main"])
    writeFileSync(join(w.work, "..", "component-work", "lib.txt"), "four\n")
    await component(["commit", "--quiet", "-am", "four"])
    const ahead = (await component(["rev-parse", "HEAD"])).trim()
    await component(["push", "--quiet", "origin", "ahead"])
    await submitGitlink(w, "task/product", ahead, "four")
    const hook = join(w.work, "..", "remote.git", "hooks", "pre-receive")
    writeFileSync(
      hook,
      `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then\n    test "$(git --git-dir='${join(w.work, "..", "component.git")}' rev-parse refs/heads/main)" = '${ahead}' || exit 1\n  fi\ndone\n`,
    )
    chmodSync(hook, 0o755)

    const outcome = await queueRun(
      await w.options({
        run: 'test "$(cat component/lib.txt)" = four && test "$(cat consumer.txt)" = four',
        on: ["submit", "merge"],
      }),
    )

    expect(outcome, readFileSync(outcome.log, "utf8")).toMatchObject({
      exitCode: 0,
      merged: ["task/product"],
      failed: [],
      stuck: [],
    })
    expect(await remoteTip(component, "refs/heads/main")).toBe(ahead)
    expect(await gitlinkAt(w, await remoteTip(w.git, "refs/heads/main"))).toBe(ahead)

    const next = await queueRun(await w.options())

    expect(next.directMerges).toEqual([])

    // This changes only the temporary component remote; root main still
    // carries `ahead`. A current tip that retreats to the old root pin went
    // around the ordered landing and must not be hidden by the prior landing.
    await gitIn(join(w.work, "..", "component.git"))(["update-ref", "refs/heads/main", w.main])
    const componentDirect = await queueRun(await w.options())

    expect(componentDirect.directMerges).toEqual([w.main])
  })

  // A root gitlink cannot retain its component objects. Existing successful
  // landing tests leave a published source ref available through intent CAS.
  it("refuses a source that loses remote reachability before the landing intent", async () => {
    const w = await world()
    const componentWork = join(w.work, "..", "component-work")
    const componentRemote = join(w.work, "..", "component.git")
    const component = gitIn(componentWork)
    await component(["checkout", "--quiet", "-b", "ahead", "main"])
    writeFileSync(join(componentWork, "lib.txt"), "four\n")
    await component(["commit", "--quiet", "-am", "four"])
    const ahead = (await component(["rev-parse", "HEAD"])).trim()
    await component(["push", "--quiet", "origin", "ahead"])
    const head = await submitGitlink(w, "task/unretained", ahead)
    const target = await remoteTip(w.git, "refs/heads/main")

    const outcome = await queueRun(
      await w.options({
        on: ["merge"],
        run: `git --git-dir='${componentRemote}' update-ref -d refs/heads/ahead`,
      }),
    )

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/unretained"] })
    expect((await component(["ls-remote", "--refs", "origin", "refs/heads/ahead"])).trim()).toBe("")
    expect(await remoteTip(component, "refs/heads/main")).toBe(w.main)
    expect(await remoteTip(w.git, "refs/heads/main")).toBe(target)
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/unretained", head })),
    )
    expect(records.some((record) => trailer(record, "Merge") !== undefined)).toBe(false)
    expect(readFileSync(outcome.log, "utf8")).toContain(
      `landing source ${ahead} is not reachable at ${componentRemote}`,
    )
  })

  // M8.5 K2: a checked intent must retain and resume its frozen M after a
  // post-child-push death. Older tests neither kill a child push nor restart
  // from a clone with the original workdir and journals gone.
  it.each([
    ["recovers the identical frozen merge from a fresh clone", false],
    ["reports every push row and makes no write after a third OID diverges", true],
  ] as const)(
    "K2 %s",
    async (_name, diverge) => {
      const w = await world()
      const componentWork = join(w.work, "..", "component-work")
      const component = gitIn(componentWork)
      await component(["checkout", "--quiet", "-b", "ahead", "main"])
      writeFileSync(join(componentWork, "lib.txt"), "four\n")
      await component(["commit", "--quiet", "-am", "four"])
      const ahead = (await component(["rev-parse", "HEAD"])).trim()
      await component(["push", "--quiet", "origin", "ahead"])
      const head = await submitGitlink(w, "task/k2", ahead, "four")
      const checkMarker = join(w.work, "..", "k2-checks.log")
      const queueBin = join(process.cwd(), "packages", "yrd-queue-core", "node_modules", ".bin")
      const env = { ...process.env, PATH: `${queueBin}:${process.env.PATH ?? ""}` }
      const options = {
        ...(await w.options({ on: ["submit", "merge"], run: `printf check >> '${checkMarker}'` })),
        env,
      }
      const event = join(w.work, "..", "k2-component-pushed.pgid")
      const hook = join(w.work, "..", "component.git", "hooks", "post-receive")
      writeFileSync(hook, `#!/bin/sh\nps -o pgid= -p $$ | tr -d ' ' > '${event}'\nwhile :; do sleep 1; done\n`)
      chmodSync(hook, 0o755)
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { queueRun } from ${JSON.stringify(join(process.cwd(), "packages/yrd-queue-core/src/run.ts"))}; await queueRun(JSON.parse(process.env.YRD_K2_OPTIONS ?? ""))`,
        ],
        { cwd: w.work, env: { ...env, YRD_K2_OPTIONS: JSON.stringify(options) }, stderr: "pipe", stdout: "ignore" },
      )
      await vi.waitFor(() => expect(readFileSync(event, "utf8").trim()).toMatch(/^[1-9][0-9]*$/u), {
        interval: 10,
        timeout: 5_000,
      })
      const group = Number(readFileSync(event, "utf8").trim())
      if (!Number.isSafeInteger(group) || group <= 0) {
        throw new Error(`component hook wrote invalid process group ${String(group)}`)
      }
      process.kill(child.pid, "SIGKILL")
      process.kill(-group, "SIGKILL")
      await child.exited
      writeFileSync(hook, "#!/bin/sh\nexit 0\n")
      chmodSync(hook, 0o755)

      expect(await remoteTip(component, "refs/heads/main")).toBe(ahead)
      const ref = changeRef("main", { branch: "task/k2", head })
      const intent = (await readRecords(w.git, await remoteTip(w.git, ref))).at(-1)!
      expect(intent.kind).toBe("checked")
      const frozen = trailer(intent, "Merge")
      if (frozen === undefined) throw new Error("the SIGKILL left no frozen Merge: intent")
      const checksBefore = readFileSync(checkMarker, "utf8")
      // Recovery must use only the frozen object IDs, not either submitted source
      // branch. Remove both source refs after the intent is durable.
      const remoteRoot = gitIn(join(w.work, "..", "remote.git"))
      await remoteRoot(["update-ref", "-d", "refs/heads/task/k2"])
      expect((await w.git(["ls-remote", "--refs", "origin", "refs/heads/task/k2"])).trim()).toBe("")
      await component(["push", "--quiet", "--delete", "origin", "ahead"])
      expect((await component(["ls-remote", "--refs", "origin", "refs/heads/ahead"])).trim()).toBe("")
      rmSync(options.workdir, { force: true, recursive: true })
      mkdirSync(options.workdir, { recursive: true })

      let third: string | undefined
      if (diverge) {
        await component(["checkout", "--quiet", "--detach", w.main])
        writeFileSync(join(componentWork, "lib.txt"), "third\n")
        await component(["commit", "--quiet", "-am", "third, divergent from ahead"])
        third = (await component(["rev-parse", "HEAD"])).trim()
        await component(["push", "--quiet", "origin", "HEAD:refs/heads/third"])
        await gitIn(join(w.work, "..", "component.git"))(["update-ref", "refs/heads/main", third])
      }

      const recovery = join(w.work, "..", diverge ? "k2-divergent-recovery" : "k2-recovery")
      await w.git(["clone", "--quiet", join(w.work, "..", "remote.git"), recovery])
      const fresh = gitIn(recovery)
      await fresh(["config", "user.email", "queue@yrd.test"])
      await fresh(["config", "user.name", "yrd"])
      const before = {
        change: await remoteTip(fresh, ref),
        component: await remoteTip(component, "refs/heads/main"),
        root: await remoteTip(fresh, "refs/heads/main"),
      }
      const outcome = await queueRun({ ...options, repo: recovery, targetSha: before.root })

      expect(readFileSync(checkMarker, "utf8")).toBe(checksBefore)
      if (!diverge) {
        expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/k2"], stuck: [] })
        expect(outcome.directMerges).toEqual([])
        expect(await remoteTip(fresh, "refs/heads/main")).toBe(frozen)
        expect(await remoteTip(component, "refs/heads/main")).toBe(ahead)
        return
      }

      expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/k2"] })
      if (third === undefined) throw new Error("the divergent K2 row has no third component OID")
      expect(outcome.directMerges).toEqual([third])
      expect({
        change: await remoteTip(fresh, ref),
        component: await remoteTip(component, "refs/heads/main"),
        root: await remoteTip(fresh, "refs/heads/main"),
      }).toEqual(before)
      const push = readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.kind === "change" && row.reason === "landing-push")
      const repositories = (
        JSON.parse(String(push?.diagnosis)) as { repositories: { refs: { destination: string; state: string }[] }[] }
      ).repositories
      expect(repositories.flatMap((repository) => repository.refs).map((row) => [row.destination, row.state])).toEqual([
        ["refs/heads/main", "failed"],
        ["refs/heads/main", "not-run"],
        [ref, "not-run"],
        [pauseRef("main"), "not-run"],
      ])
    },
    30_000,
  )

  // M8.5 K3: an external release pin is deliberately as-written, unlike the
  // product landing rows exercised above.
  it("K3 keeps an external release pin as written without pushing its component", async () => {
    const w = await world("external")
    await submitGitlink(w, "task/external-release", w.offMain)
    const component = gitIn(join(w.work, "..", "component-work"))
    const main = await remoteTip(component, "refs/heads/main")

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/external-release"], stuck: [] })
    expect(await remoteTip(component, "refs/heads/main")).toBe(main)
    expect(await gitlinkAt(w, await remoteTip(w.git, "refs/heads/main"))).toBe(w.offMain)
  })

  // M8.5 policy comes from the fetched protected main, never the authored
  // checkout. Existing K1/K3 fixtures have identical policy on both commits.
  it.each(["product", "external"] as const)("uses protected %s mode despite the authored config", async (mode) => {
    const w = await world(mode)
    const componentWork = join(w.work, "..", "component-work")
    const component = gitIn(componentWork)
    await component(["checkout", "--quiet", "-b", "different-policy", "main"])
    writeFileSync(join(componentWork, ".yrd.yml"), `landing: ${mode === "product" ? "external" : "product"}\n`)
    await component(["commit", "--quiet", "-am", "author a different landing policy"])
    const authored = (await component(["rev-parse", "HEAD"])).trim()
    await component(["push", "--quiet", "origin", "different-policy"])
    const head = await submitGitlink(w, "task/protected-policy", authored)

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/protected-policy"], stuck: [] })
    expect(await remoteTip(component, "refs/heads/main")).toBe(mode === "product" ? authored : w.main)
    expect(await gitlinkAt(w, await remoteTip(w.git, "refs/heads/main"))).toBe(authored)
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/protected-policy", head })),
    )
    const intent = records.find((record) => record.kind === "checked" && trailer(record, "Merge") !== undefined)!
    const policy = intent.trailers
      .filter(([key]) => key === "Config")
      .map(([, value]) => value)
      .find((value) => value.includes('"repository":"component"'))
    expect(JSON.parse(policy ?? "null")).toMatchObject({ landing: mode, target: w.main })
  })

  // A required protected declaration is a direct-reader authority failure,
  // before any candidate record, check, or push can happen.
  it("stops the whole run on missing protected landing mode before candidate work", async () => {
    const w = await world()
    const componentWork = join(w.work, "..", "component-work")
    const component = gitIn(componentWork)
    writeFileSync(join(componentWork, ".yrd.yml"), "{}\n")
    await component(["commit", "--quiet", "-am", "remove protected landing declaration"])
    await component(["push", "--quiet", "origin", "main"])
    const protectedMain = await remoteTip(component, "refs/heads/main")
    const target = await remoteTip(w.git, "refs/heads/main")
    const head = await submitFile(w, "task/missing-policy")
    const ref = changeRef("main", { branch: "task/missing-policy", head })
    const opened = await remoteTip(w.git, ref)
    const marker = join(w.work, "..", "missing-policy-check")
    const failure = `component .yrd.yml at protected main ${protectedMain} must declare landing: product or external before the queue can judge it`

    const outcome = await queueRun(await w.options({ on: ["submit"], run: `touch '${marker}'` }))

    expect(outcome).toMatchObject({
      directMerges: [],
      exitCode: 2,
      failed: [],
      merged: [],
      stopped: { ring: "direct", says: failure, what: { reason: "direct-read-failed" } },
      stuck: [],
    })
    expect(existsSync(marker)).toBe(false)
    expect(await remoteTip(w.git, "refs/heads/main")).toBe(target)
    expect(await remoteTip(component, "refs/heads/main")).toBe(protectedMain)
    expect(await remoteTip(w.git, ref)).toBe(opened)
    const records = await readRecords(w.git, opened)
    expect(records.map((record) => record.kind)).toEqual(["opened"])
    expect(
      records.some((record) => trailer(record, "Check") !== undefined || trailer(record, "Merge") !== undefined),
    ).toBe(false)
    const journal = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(journal.filter((record) => record.kind === "change" && record.head === head)).toEqual([])
    expect(journal).toContainEqual(
      expect.objectContaining({ exit: 2, kind: "result", reason: "direct-read-failed", text: failure }),
    )
  })

  it("a divergent authored pin fails its author while the next change proceeds, then a rebased submission lands", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/off", w.offMain)
    await submitFile(w, "task/next")

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/off"], merged: ["task/next"], stuck: [] })
    const records = await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/off", head })))
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records.find((record) => record.kind === "failed")!
    expect(trailer(failed, "Fault")).toBe("submitter")
    expect(trailer(failed, "Reason")).toContain(w.offMain)
    expect(trailer(failed, "Remedy")).toContain("Rebase")
    expect(trailer(failed, "Remedy")).toContain(w.main)
    expect(records.some((record) => trailer(record, "Merge") !== undefined)).toBe(false)
    const queue = await readQueue(w.git, "origin", "main", await remoteTip(w.git, "refs/heads/main"))
    expect(queue.changes.find((entry) => entry.change.head === head)?.reading.state).toBe("failed")
    const journals = readJournals(dirname(outcome.log))
    const failedRow = list(queue.changes, { journals }).find((row) => row.head === head)
    expect(failedRow).toMatchObject({ state: "failed" })
    expect(failedRow?.position).toBeUndefined()
    const shown = watchRows(list(queue.changes, { journals }), { journals }).find((row) => row.row.head === head)!
    expect(shown.row.state).toBe("failed")
    expect(readFileSync(outcome.log, "utf8")).toContain(w.offMain)
    const component = gitIn(join(w.work, "..", "component-work"))
    expect(await remoteTip(component, "refs/heads/main")).toBe(w.main)

    const repeated = await queueRun(await w.options())
    expect(repeated).toMatchObject({ exitCode: 0, failed: [], merged: [], stuck: [] })
    expect(
      (await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/off", head })))).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened", "failed", "sent"])

    const componentWork = join(w.work, "..", "component-work")
    await component(["checkout", "--quiet", "main"])
    writeFileSync(join(componentWork, "rebased-feature.txt"), "feature based on current main\n")
    await component(["add", "rebased-feature.txt"])
    await component(["commit", "--quiet", "-m", "feature rebased onto component main"])
    const rebased = (await component(["rev-parse", "HEAD"])).trim()
    await component(["push", "--quiet", "origin", `${rebased}:refs/heads/rebased`])
    const replacement = await submitGitlink(w, "task/rebased", rebased)

    const retried = await queueRun(await w.options())

    expect(retried).toMatchObject({ exitCode: 0, failed: [], merged: ["task/rebased"], stuck: [] })
    expect(
      (
        await readRecords(
          w.git,
          await remoteTip(w.git, changeRef("main", { branch: "task/rebased", head: replacement })),
        )
      ).map((record) => record.kind),
    ).toEqual(["opened", "checked", "checked", "merged", "sent"])
    expect(await gitlinkAt(w, await remoteTip(w.git, "refs/heads/main"))).toBe(rebased)
    expect(await remoteTip(component, "refs/heads/main")).toBe(rebased)
  }, 15_000)

  it("a held-back authored pin merges raised and keeps the submitted Change identity", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/on", w.onMain)

    const outcome = await queueRun(await w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/on"])
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(w.main)
    const message = await w.git(["show", "-s", "--format=%B", target])
    expect(message).toContain(`Change: task/on@${head}`)
    expect(message).toContain(`Settled: component@${w.main}`)
    const merge = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.kind === "merge")
    expect(merge?.gitlinks).toContain(`component ${w.onMain} -> ${w.main}`)
  })

  it("the queue-owned merge is isolated from vetoing and observing repository hooks", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/hook-isolation", w.onMain)
    const observed = join(w.work, "..", "queue-hook-observed.log")
    for (const [hook, exit] of [
      ["prepare-commit-msg", 1],
      ["post-commit", 0],
    ] as const) {
      const path = join(w.work, ".git", "hooks", hook)
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${hook}' >> '${observed}'\nexit ${String(exit)}\n`)
      chmodSync(path, 0o755)
    }

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/hook-isolation"], stuck: [] })
    expect(existsSync(observed)).toBe(false)
    const target = await remoteTip(w.git, "refs/heads/main")
    expect((await w.git(["rev-list", "--parents", "-n", "1", target])).trim().split(" ")).toHaveLength(3)
    expect(await w.git(["show", "-s", "--format=%B", target])).toContain(`Settled: component@${w.main}`)
    expect(await gitlinkAt(w, target)).toBe(w.main)
    expect(
      (
        await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/hook-isolation", head })))
      ).map((record) => record.kind),
    ).toEqual(["opened", "checked", "checked", "merged", "sent"])
  })

  /** M8.5: untouched pins belong to the target, not this change's settlements. */
  it("an untouched off-main target pin stays put without a settlement row", async () => {
    const w = await world()
    await gitlinkAroundQueue(w, w.offMain)
    await submitFile(w, "task/pass-over-off-main")

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/pass-over-off-main"] })
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(w.offMain)
    expect((await w.git(["show", "-s", "--format=%(trailers:key=Settled,valueonly)", target])).trim()).toBe("")
    const settle = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "settle")
    expect(settle).toEqual([])
  })

  it("an unfetchable candidate gitlink fails the submitter and the next change proceeds", async () => {
    const w = await world()
    const missing = "f".repeat(40)
    const head = await submitMissingGitlink(w, "task/missing", missing)
    await submitFile(w, "task/next")

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/missing"], merged: ["task/next"], stuck: [] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/missing", head })),
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records.find((record) => record.kind === "failed")
    expect(trailer(failed!, "Fault")).toBe("submitter")
    expect(trailer(failed!, "Reason")).toContain(missing)
    expect(failed?.subject).toContain("component")
  })

  it("normalizes an unrecognized git-super failure without losing its boundary detail", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/unreadable-main", w.onMain)
    const missing = join(w.work, "missing-component.git")
    let external: Readonly<{ code: string; phase: string; message: string }> | undefined
    await using real = createProcess({ cwd: w.work })
    const observing: Process = {
      ...real,
      async run(request) {
        const merge =
          request.argv.includes("merge") && (request.argv[0] === "git-super" || request.argv.includes("super"))
        if (merge) await gitIn(join(request.cwd ?? w.work, "component"))(["remote", "set-url", "origin", missing])
        const result = await real.run(request)
        if (merge) {
          external = (
            JSON.parse(result.stdout) as Readonly<{
              detail?: Readonly<{ code: string; phase: string; message: string }>
            }>
          ).detail
        }
        return result
      },
    }

    const outcome = await queueRun({ ...(await w.options()), process: observing })

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/unreadable-main"] })
    expect(external).toMatchObject({ code: "component-main-unreadable", phase: "read-component-main" })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/unreadable-main", head })),
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    const stuck = records[1]!
    expect(trailer(stuck, "Code")).toBe("yrd-merge-unresolved")
    expect(trailer(stuck, "Subject")).toContain("component")
    expect(trailer(stuck, "Via")).toContain("component-main-unreadable")
    expect(trailer(stuck, "Via")).toContain("read-component-main")
    expect(trailer(stuck, "Evidence")).toBe(outcome.log)
    expect(trailer(stuck, "Owner")).toBeUndefined()
    expect(trailer(records[2]!, "Owner")).toBeUndefined()
    if (external === undefined) throw new Error("git-super returned no failure detail")
    const evidence = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(evidence.filter((record) => record.kind === "change" && record.head === head)).toEqual([
      expect.objectContaining({
        branch: "task/unreadable-main",
        code: "yrd-merge-unresolved",
        decision: "stuck",
        diagnosisCode: external.code,
        phase: external.phase,
        reason: external.message,
      }),
    ])
  })

  // A non-0/1 ancestry proof is a GitSuper operational fault, not the
  // divergent authored-pin result (`component-main-moved`) it would have
  // proved. The normal divergent-pin case did not exercise this boundary.
  it("keeps an unreadable gitlink ancestry proof queue-owned and preserves its raw detail", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/ancestry-unreadable", w.offMain)
    const target = await remoteTip(w.git, "refs/heads/main")
    const detail = {
      code: "git-failed",
      message: "git merge-base failed while proving the component pin",
      phase: "prove-gitlink-on-main",
    }
    await using real = createProcess({ cwd: w.work })
    const observing: Process = {
      ...real,
      async run(request) {
        if (request.argv.includes("super") && request.argv.includes("merge")) {
          return {
            durationMs: 0,
            exitCode: 2,
            signal: null,
            stderr: "",
            stdout: JSON.stringify({ detail, gitlinks: [], partial: false, state: "failed" }),
            timedOut: false,
          }
        }
        return real.run(request)
      },
    }

    const outcome = await queueRun({ ...(await w.options()), process: observing })

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/ancestry-unreadable"] })
    expect(await remoteTip(w.git, "refs/heads/main")).toBe(target)
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/ancestry-unreadable", head })),
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    expect(trailer(records[1]!, "Via")).toContain("git-failed")
    expect(trailer(records[1]!, "Via")).toContain("prove-gitlink-on-main")
    const evidence = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(evidence).toContainEqual(
      expect.objectContaining({
        branch: "task/ancestry-unreadable",
        code: "yrd-merge-unresolved",
        diagnosisCode: detail.code,
        phase: detail.phase,
        reason: detail.message,
      }),
    )
  })

  it("a candidate failure introduced by raising component main is queue-owned stuck", async () => {
    const w = await world()
    const breaking = await advanceComponent(w, "breaking component main")
    const head = await submitGitlink(w, "task/base-red", w.onMain)

    const outcome = await queueRun(
      await w.options({ on: ["submit"], run: "! grep -q 'breaking component main' component/lib.txt" }),
    )

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/base-red"] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/base-red", head })),
    )
    const stuck = records.find((record) => record.kind === "stuck")
    expect(trailer(stuck!, "Code")).toBe("yrd-submodule-main-regression")
    expect(trailer(stuck!, "Subject")).toContain("component")
    expect(trailer(stuck!, "Subject")).toContain(breaking)
    expect(trailer(stuck!, "Evidence")).toBe(outcome.log)
    expect(trailer(stuck!, "Next")).toContain("yrd queue run")
    expect(
      records
        .filter((record) => record.kind === "stuck" || record.kind === "sent")
        .map((record) => trailer(record, "Owner")),
    ).toEqual([undefined, undefined])
    expect(trailer(stuck!, "Fault")).toBeUndefined()
    const phases = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "result" && record.name === "component-check")
      .map((record) => record.phase)
    expect(phases).toEqual(["submit", "base"])
  })

  /** Attribution must compare candidate-minus-content even when root main's old pin is divergent, not silently keep that old tree. */
  it("the settled-base comparator applies a raise over an off-main target pin", async () => {
    const w = await world()
    await gitlinkAroundQueue(w, w.offMain)
    const head = await submitGitlink(w, "task/repair-off-main", w.onMain)

    const outcome = await queueRun(await w.options({ on: ["submit"], run: "! grep -q '^three$' component/lib.txt" }))

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/repair-off-main"] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/repair-off-main", head })),
    )
    const stuck = records.find((record) => record.kind === "stuck")
    expect(trailer(stuck!, "Code")).toBe("yrd-submodule-main-regression")
    expect(trailer(stuck!, "Subject")).toContain(`component@${w.main}`)
    const phases = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "result" && record.name === "component-check")
      .map((record) => record.phase)
    expect(phases).toEqual(["submit", "base"])
  })

  it("a candidate-only failure stays the submitter's when the settled base is green", async () => {
    const w = await world()
    await advanceComponent(w, "healthy component main")
    const head = await submitGitlink(w, "task/candidate-red", w.onMain, "candidate")

    const outcome = await queueRun(
      await w.options({
        on: ["submit"],
        run: "if test -f consumer.txt; then echo CANDIDATE_FAIL; exit 1; else echo BASE_PASS; fi",
      }),
    )

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/candidate-red"], merged: [], stuck: [] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/candidate-red", head })),
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    expect(trailer(records.find((record) => record.kind === "failed")!, "Fault")).toBe("submitter")
    const phases = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "result" && record.name === "component-check")
      .map((record) => record.phase)
    expect(phases).toEqual(["submit", "base"])
    // The read-side must not relabel the green comparator as the candidate's
    // deciding artifact, nor collapse its two measured phase occurrences.
    const journals = readJournals(dirname(outcome.log))
    const queue = await readQueue(w.git, "origin", "main", outcome.target)
    const shown = watchRows(list(queue.changes, { journals }), { journals }).find((row) => row.row.head === head)!
    expect(shown.row.result).toBe("fail component-check")
    expect(readFileSync(shown.row.log!, "utf8")).toBe("CANDIDATE_FAIL\n")
    const detail = checksOf([], "failed", [], shown.run?.running, shown.run?.checks)
    expect(detail.map((check) => [check.phase, check.state, readFileSync(check.log!, "utf8")])).toEqual([
      ["submit", "failed", "CANDIDATE_FAIL\n"],
      ["base", "passed", "BASE_PASS\n"],
    ])
  })

  it("a gitlink moved on the target around the queue is reported with its path, and no component is asked about it (E5)", async () => {
    const w = await world()
    // One change first: the queue's history starts at its own first record, so a
    // queue that has judged nothing reports nothing (direct.ts). Its branch is
    // then taken away, so the run retires it without building a worktree and
    // the count below stays about the direct-merge reading alone.
    await submitFile(w, "task/first")
    await w.git(["push", "--quiet", "origin", ":task/first"])
    const direct = await gitlinkAroundQueue(w, w.offMain)

    const outcome = await queueRun(await w.options())

    expect(outcome.exitCode).toBe(0)
    // The root now pins `offMain`, while product component main still names
    // `main`. Both current positions are unexplained: the root moved around
    // the queue, and no landing (or current root pin) explains component main.
    expect(outcome.directMerges).toEqual([direct, w.main])
    const log = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(log.filter((record) => record.kind === "merged-direct")).toMatchObject([
      { branch: "main", commit: direct, gitlinks: ["component"] },
      { branch: "component/main", commit: w.main },
    ])
    const told = log.filter((record) => record.kind === "message" && record.says === "merged-direct")
    const rootNotice = told.find((record) => record.id === direct)
    expect(rootNotice).toMatchObject({ id: direct, says: "merged-direct", to: "none" })
    expect(rootNotice?.text).toContain(`main moved around the queue at ${direct.slice(0, 12)}`)
    expect(rootNotice?.text).toContain("it moved the gitlink at component")
  })

  // M8.5 E5: a product component main is queue-owned only through a root
  // landing. The root-direct case above cannot expose a component-only push;
  // external keeps its own release identity and is deliberately exempt.
  it.each([
    ["product with queue history", "product", true, true],
    ["product without queue history", "product", true, false],
    ["external with queue history", "external", false, true],
  ] as const)(
    "reports a %s component main hand push only when it is product (E5)",
    async (_name, landing, reports, history) => {
      const w = await world(landing)
      if (history) {
        await submitFile(w, "task/first")
        await w.git(["push", "--quiet", "origin", ":task/first"])
      }
      const direct = await advanceComponent(w, `${landing} main moved around the queue`)
      const root = await remoteTip(w.git, "refs/heads/main")

      expect(await gitlinkAt(w, root)).toBe(w.main)

      const outcome = await queueRun(await w.options())

      // `directMerges` is the existing queue-run/direct hook; no new public
      // output shape is needed to prove that the component push is observed.
      expect(outcome.directMerges).toEqual(reports ? [direct] : [])
      const records = readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.kind === "merged-direct")
      expect(records).toMatchObject(reports ? [{ branch: "component/main", commit: direct }] : [])
    },
  )

  it.each([
    ["does not treat expectedDestination as authority", "checked", "expected-destination"],
    ["does not let a failed record leave its landing intent current", "failed", "source"],
  ] as const)("%s", async (_name, terminal, position) => {
    const w = await world()
    const source = await advanceComponent(w, "landing source")
    const expectedDestination = position === "expected-destination" ? w.onMain : w.main
    const componentRemote = gitIn(join(w.work, "..", "component.git"))
    if (position === "expected-destination") {
      // `T` is the landing CAS pre-image but neither the root pin nor source.
      await componentRemote(["update-ref", "refs/heads/main", expectedDestination])
    }
    const head = await submitFile(w, `task/${position}`)
    const change = { branch: `task/${position}`, head }
    const landing = {
      destination: "refs/heads/main",
      expectedDestination: { oid: expectedDestination, state: "oid" },
      remote: join(w.work, "..", "component.git"),
      repository: "component",
      source,
    }
    const checked = await appendRecord(w.git, "main", {
      change,
      kind: "checked",
      subject: "frozen product landing",
      trailers: [
        ["Base", await remoteTip(w.git, "refs/heads/main")],
        ["Config", "test-config"],
        ["Config", JSON.stringify({ remote: join(w.work, "..", "remote.git"), repository: "." })],
        ["Landing", JSON.stringify(landing)],
        ["Merge", await remoteTip(w.git, "refs/heads/main")],
        ["Merged-By", "main@direct-test"],
      ],
    })
    const tip =
      terminal === "failed"
        ? await appendRecord(w.git, "main", {
            change,
            kind: "failed",
            subject: "landing retired before root push",
            trailers: [["Reason", "landing no longer current"]],
          })
        : checked
    const ref = changeRef("main", change)
    await w.git(["push", "--quiet", "origin", `${tip}:${ref}`])

    const target = await remoteTip(w.git, "refs/heads/main")
    const entries = (await readQueue(w.git, "origin", "main", target)).changes
    expect((await readRecords(w.git, await remoteTip(w.git, ref))).map((record) => record.kind)).toEqual(
      terminal === "failed" ? ["opened", "checked", "failed"] : ["opened", "checked"],
    )

    const found = await directMergeCommits(w.git, "main", target, entries, {
      remote: "origin",
      repo: w.work,
      workdir: join(w.work, "..", "direct-read"),
    })

    expect(found).toMatchObject([
      {
        commit: position === "expected-destination" ? expectedDestination : source,
        target: "component/main",
      },
    ])
  })

  // Persistent readers must observe new protected tips without checking out a
  // component or moving the caller's refs. Accounting-only cases cannot catch
  // a fresh checkout on every read, even when its verdict is correct.
  it("reuses component stores across direct reads without worktrees or shared ref writes", async () => {
    const w = await world()
    const target = await remoteTip(w.git, "refs/heads/main")
    const entries = (await readQueue(w.git, "origin", "main", target)).changes
    const componentGit = gitIn(join(w.work, "component"))
    const refs = ["for-each-ref", "--format=%(refname)%00%(objectname)"]
    const before = await componentGit(refs)
    const fetchHead = (await componentGit(["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"])).trim()
    writeFileSync(fetchHead, "caller-owned component fetch evidence\n")
    const operations: string[][] = []
    await using real = createProcess({ cwd: w.work })
    const observing: Process = {
      ...real,
      async run(request) {
        operations.push([...request.argv])
        return real.run(request)
      },
    }
    const git = gitIn(w.work, observing)
    const context = {
      process: observing,
      remote: "origin",
      repo: w.work,
      workdir: join(w.work, "..", "direct-read"),
    }
    const firstTip = await advanceComponent(w, "first observed component tip")
    const first = await directMergeCommits(git, "main", target, entries, context)
    const secondTip = await advanceComponent(w, "second observed component tip")
    const second = await directMergeCommits(git, "main", target, entries, context)

    expect(first.map(({ commit }) => commit)).toEqual([firstTip])
    expect(second.map(({ commit }) => commit)).toEqual([secondTip])
    expect(operations.filter((argv) => argv.includes("worktree"))).toEqual([])
    expect(await componentGit(refs)).toBe(before)
    expect(readFileSync(fetchHead, "utf8")).toBe("caller-owned component fetch evidence\n")
  })

  it.each([
    ["a new change ref", async (w: World, direct: string) => submitFile(w, `task/direct-read-${direct.slice(0, 8)}`)],
    ["a moved root", async (w: World, direct: string) => gitlinkAroundQueue(w, direct)],
  ] as const)("abandons a mixed direct read when %s arrives during component observation", async (_name, move) => {
    const w = await world()
    const direct = await advanceComponent(w, "component moves during direct read")
    let moved = false
    await using real = createProcess({ cwd: w.work })
    const observing: Process = {
      ...real,
      async run(request) {
        const result = await real.run(request)
        if (!moved && request.argv.includes("show") && request.argv.includes("--no-patch")) {
          moved = true
          await move(w, direct)
        }
        return result
      },
    }

    const outcome = await queueRun({ ...(await w.options()), process: observing })

    expect(moved).toBe(true)
    expect(outcome).toMatchObject({ directMerges: [], exitCode: 0, failed: [], merged: [], stuck: [] })
    const records = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.filter((record) => record.kind === "merged-direct")).toEqual([])
    expect(records).toContainEqual(
      expect.objectContaining({
        exit: 0,
        kind: "result",
        reason: "direct-read-changed",
        text: expect.stringContaining("read the queue again"),
      }),
    )
  })

  // The direct reader is a pre-verdict observation. A transport outage while
  // reading protected component state or its final queue fence asks the next
  // pass to read again; it must not turn an unjudged change into a failure.
  it.each(["fetch", "fence ls-remote"] as const)(
    "stops cleanly when direct component %s is temporarily unavailable",
    async (kind) => {
      const w = await world()
      const head = await submitFile(w, `task/direct-${kind.replaceAll(" ", "-")}`)
      const ref = changeRef("main", { branch: `task/direct-${kind.replaceAll(" ", "-")}`, head })
      const opened = await remoteTip(w.git, ref)
      const target = await remoteTip(w.git, "refs/heads/main")
      const protectedMain = await remoteTip(gitIn(join(w.work, "..", "component-work")), "refs/heads/main")
      const marker = join(w.work, "..", `direct-${kind.replaceAll(" ", "-")}-check`)
      const detail = `simulated direct ${kind} transport outage`
      let componentMainRead = false
      let failure: string | undefined
      await using real = createProcess({ cwd: w.work })
      const observing: Process = {
        ...real,
        async run(request) {
          const componentFetch =
            request.argv[0] === "git" &&
            request.argv[1] === "fetch" &&
            request.argv.includes("--no-tags") &&
            request.argv.includes("+refs/heads/main:refs/remotes/origin/main")
          const queueFence =
            componentMainRead &&
            request.argv[0] === "git" &&
            request.argv[1] === "ls-remote" &&
            request.argv[2] === "--refs" &&
            request.argv[3] === "origin"
          if ((kind === "fetch" && componentFetch) || (kind === "fence ls-remote" && queueFence)) {
            failure = `git ${request.argv.slice(1).join(" ")} in ${request.cwd ?? w.work} exited 128: ${detail}`
            return {
              durationMs: 0,
              exitCode: 128,
              signal: null,
              stderr: detail,
              stdout: "",
              timedOut: false,
            }
          }
          const result = await real.run(request)
          if (
            request.argv[0] === "git" &&
            request.argv[1] === "rev-parse" &&
            request.argv[2] === "refs/remotes/origin/main^{commit}"
          ) {
            componentMainRead = true
          }
          return result
        },
      }

      const outcome = await queueRun({
        ...(await w.options({ on: ["submit"], run: `touch '${marker}'` })),
        process: observing,
      })

      if (failure === undefined) throw new Error(`did not intercept direct ${kind}`)
      expect(outcome).toMatchObject({
        directMerges: [],
        exitCode: 0,
        failed: [],
        merged: [],
        stopped: { ring: "direct", says: failure, what: { reason: "direct-read-unavailable" } },
        stuck: [],
      })
      expect(existsSync(marker)).toBe(false)
      expect(await remoteTip(w.git, "refs/heads/main")).toBe(target)
      expect(await remoteTip(gitIn(join(w.work, "..", "component-work")), "refs/heads/main")).toBe(protectedMain)
      expect(await remoteTip(w.git, ref)).toBe(opened)
      expect((await readRecords(w.git, opened)).map((record) => record.kind)).toEqual(["opened"])
      const records = readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(records.filter((record) => record.kind === "change" && record.head === head)).toEqual([])
      expect(records).toContainEqual(
        expect.objectContaining({ exit: 0, kind: "result", reason: "direct-read-unavailable", text: failure }),
      )
    },
  )

  it("a gitlink the reference checkout never fetched is materialized from the component's remote, and the change merges", async () => {
    const w = await world()
    // The component's main moves on in its own clone and the reference
    // checkout under `work` never fetches it; the change records it by plumbing,
    // so the reference's submodule store lacks the commit when the queue
    // builds the worktree. The queue fetches it there (2026-09-03: it refused
    // the network and stuck on @dev/2's 24089 instead).
    const componentWork = join(w.work, "..", "component-work")
    const cg = gitIn(componentWork)
    writeFileSync(join(componentWork, "lib.txt"), "four\n")
    await cg(["commit", "--quiet", "-am", "four"])
    await cg(["push", "--quiet", "origin", "main"])
    const four = (await cg(["rev-parse", "HEAD"])).trim()
    // Plumbing only: the working tree and its submodule checkout stay where
    // they are, so nothing here fetches the commit into the reference store.
    const base = (await w.git(["rev-parse", "main"])).trim()
    await w.git(["read-tree", "main"])
    await w.git(["update-index", "--add", "--cacheinfo", `160000,${four},component`])
    const tree = (await w.git(["write-tree"])).trim()
    const head = (
      await w.git([
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        "task/unfetched: move the component gitlink to a commit this checkout never fetched",
      ])
    ).trim()
    await w.git(["update-ref", "refs/heads/task/unfetched", head])
    await w.git(["read-tree", "main"])
    await submit(w.git, "origin", {
      branch: "task/unfetched",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    const outcome = await queueRun(await w.options())

    expect(outcome.exitCode).toBe(0)
    const kinds = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/unfetched", head })))
    ).map((record) => record.kind)
    expect(kinds).not.toContain("stuck")
    expect(kinds).toContain("merged")
  })

  it("two changes moving the same gitlink ask the component once per run: a commit on main stays on main (E4)", async () => {
    const w = await world()
    await submitGitlink(w, "task/first", w.onMain)
    const second = await submitGitlink(w, "task/second", w.onMain)

    const outcome = await queueRun(await w.options())

    // Both were judged on submit — the first fetched, the second read the
    // run's answer — and one merge per run lands the first (ruling D4).
    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/first"])
    expect(
      (
        await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/second", head: second })))
      ).map((record) => record.kind),
    ).toEqual(["opened", "checked"])
  })
})
