/**
 * @reach fs-walk <fixture-only: temporary bare remotes, a real submodule checkout and provider call logs>
 * @failure A landing that raises a component gitlink leaves the component's `Closes:` issue open (only the root
 *          range is read), closes an issue named only by `Refs:`, closes or resolves one issue twice when the root
 *          and the component both name it, or silently skips a component range whose pin the queue clone cannot
 *          resolve instead of failing the attempt by name.
 * @level l2 (the real `yrd queue up` service against bare remotes, a real submodule and issues.yml providers)
 * @consumer Yrd post-merge closer reading component ranges (hh 29630, @cto 5a66fb46)
 * @testonly none
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { safeRemoveSync } from "removely"
import { coreQueueCommand } from "../src/queue-core-commands.ts"
import { createPostMerge, readPostMergeIssueDiagnostics } from "../src/post-merge.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { openEvents } from "../../yrd-queue-core/src/git.ts"
import { changeInput } from "../../yrd-queue-core/src/events.ts"
import { changesRef, createEventQueue, createEventStore, readConfig, readStatus } from "@yrd/queue-core"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
})

// `git submodule add` from a local bare remote needs the file transport; every git child of the queue inherits it.
const gitConfigKeys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const
const priorGitConfig = new Map(gitConfigKeys.map((key) => [key, process.env[key]]))
beforeAll(() => {
  process.env.GIT_CONFIG_COUNT = "1"
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
  process.env.GIT_CONFIG_VALUE_0 = "always"
})
afterAll(() => {
  for (const key of gitConfigKeys) {
    const prior = priorGitConfig.get(key)
    if (prior === undefined) delete process.env[key]
    else process.env[key] = prior
  }
})

const COMPONENT = "vendor/one"

/** Lines of a provider call log; none when the provider was never called. */
const lines = (path: string): string[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : []

/** Every finished post-merge attempt record under `workdir`. */
const attempts = (workdir: string): Array<Record<string, unknown>> => {
  const directory = join(workdir, "post-merge")
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Record<string, unknown>)
    .filter((attempt) => attempt.status !== "running" && attempt.endedAt !== undefined)
}

const issueActions = (attempt: Record<string, unknown>): Array<Record<string, unknown>> =>
  (attempt.issueActions ?? []) as Array<Record<string, unknown>>

/**
 * A root queue on a bare remote whose author clone (also the queue clone) carries one real submodule at
 * `vendor/one`. issues.yml's `resolve` logs each raw value and answers it as the key; `close` logs each key.
 */
const submoduleQueue = async () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-29630-"))
  roots.push(root)
  const seed = gitIn(root)
  const componentRemote = join(root, "one.git")
  const componentWork = join(root, "one-work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", componentRemote])
  await seed(["clone", "--quiet", componentRemote, componentWork])
  const upstream = gitIn(componentWork)
  await upstream(["config", "user.email", "component@yrd.test"])
  await upstream(["config", "user.name", "fixture"])
  await upstream(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(componentWork, "one.txt"), "old\n")
  await upstream(["add", "."])
  await upstream(["commit", "--quiet", "-m", "one: old\n\nCloses: issue-before-the-range"])
  await upstream(["push", "--quiet", "origin", "main"])

  const remote = join(root, "remote.git"),
    repo = join(root, "author"),
    workdir = join(root, "queue"),
    closeCalls = join(root, "close-calls.tsv"),
    resolveCalls = join(root, "resolve-calls.txt"),
    // When present, resolve names every issue by a new key: the provider re-keyed it.
    rekey = join(root, "rekey.txt")
  mkdirSync(workdir)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.email", "provider@yrd.test"])
  await git(["config", "user.name", "fixture"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(repo, ".yrd.yml"), "{}\n")
  writeFileSync(
    join(repo, "issues.yml"),
    JSON.stringify({
      resolve: [
        "sh",
        "-c",
        'k="$1"; [ -f "$3" ] && k="$k$(cat "$3")"; printf "%s\\n" "$1" >> "$2"; printf \'{"keys":["%s"]}\\n\' "$k"',
        "resolve",
        "<raw>",
        resolveCalls,
        rekey,
      ],
      close: [
        "sh",
        "-c",
        'printf "%s\\t%s\\t%s\\n" "$1" "$2" "$3" >> "$4"; printf \'{"applied":true}\\n\'',
        "close",
        "<key>",
        "<reason>",
        "<id>",
        closeCalls,
      ],
    }),
  )
  await git(["submodule", "add", "--quiet", componentRemote, COMPONENT])
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "root with one component"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim(),
    config = await readConfig(git, target, { remote: "origin", branch: "main" })
  if (config === undefined) throw Error("fixture queue lost config")
  const store = createEventStore(repo, "origin", git.selection)
  const queueTip = await createEventQueue(store, "main", target, config, new Date())
  const checkout = gitIn(join(repo, COMPONENT))
  await checkout(["config", "user.email", "component@yrd.test"])
  await checkout(["config", "user.name", "fixture"])
  return { root, repo, workdir, closeCalls, resolveCalls, rekey, git, store, target, queueTip, checkout, upstream }
}
type SubmoduleQueue = Awaited<ReturnType<typeof submoduleQueue>>

/** One component commit carrying `message`, made in the queue clone's own submodule checkout (its reference store). */
const componentCommit = async (world: SubmoduleQueue, message: string): Promise<string> => {
  await world.checkout(["checkout", "--quiet", "--detach"])
  writeFileSync(join(world.repo, COMPONENT, "one.txt"), `${message}\n`)
  await world.checkout(["commit", "--quiet", "-am", message])
  return (await world.checkout(["rev-parse", "HEAD"])).trim()
}

/**
 * Opens `branch` on the queue at one root commit that raises the gitlink to `pin` (with `rootMessage`), then lands
 * it on main directly, so the next round observes the delivery and its post-merge closer reads base..merge.
 */
const landRaise = async (world: SubmoduleQueue, branch: string, pin: string, rootMessage: string): Promise<string> => {
  const { git } = world
  await git(["checkout", "--quiet", "-b", branch, "origin/main"])
  await git(["update-index", "--cacheinfo", `160000,${pin},${COMPONENT}`])
  await git(["commit", "--quiet", "-m", rootMessage])
  const head = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", branch])
  await (
    await openEvents({ ...world.store, ref: changesRef("main", branch) })
  ).append(
    [
      changeInput("opened", {
        queueTip: world.queueTip,
        at: new Date(),
        commit: head,
        by: "fixture",
        base: world.target,
      }),
    ],
    { expect: null },
  )
  await git(["checkout", "--quiet", "main"])
  await git(["push", "--quiet", "origin", `${branch}:refs/heads/main`])
  return head
}

/** Runs `yrd queue up` with automatic close until `settled` holds for the finished attempts, then stops it. */
const runQueue = async (
  world: SubmoduleQueue,
  branch: string,
  settled: (finished: Array<Record<string, unknown>>) => boolean,
): Promise<string[]> => {
  const stop = new AbortController(),
    merged: string[] = [],
    diagnostics: string[] = []
  let rounds = 0
  try {
    expect(
      await coreQueueCommand(
        world.repo,
        {
          cwd: world.repo,
          stdout: (s) => diagnostics.push(s),
          stderr: (s) => diagnostics.push(s),
          localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
        },
        {
          command: "up",
          intervalSeconds: 0,
          stop: stop.signal,
          afterRound: async (outcome) => {
            rounds++
            merged.push(...outcome.merged)
            if (merged.includes(branch)) {
              await vi.waitFor(() => expect(settled(attempts(world.workdir)), diagnostics.join(" ")).toBe(true), {
                timeout: 15000,
              })
              stop.abort()
            } else if (rounds > 4) stop.abort()
          },
        },
        { workdir: world.workdir, json: true, projectRoot: world.repo },
      ),
      diagnostics.join(" "),
    ).toBe(0)
  } finally {
    stop.abort()
  }
  expect(merged, diagnostics.join(" ")).toContain(branch)
  return diagnostics
}

/** The branch-level row closeMergedIssues writes once it has walked every merged segment of `branch`. */
const walked =
  (branch: string) =>
  (finished: Array<Record<string, unknown>>): boolean =>
    finished.some((attempt) =>
      issueActions(attempt).some(
        (action) => action.branch === branch && action.mergedEvent === "" && action.verb === undefined,
      ),
    )

/** @failure A component commit's `Closes:` is lost when no root commit names it. @level l2 @consumer hh 29630 component-range close @testonly none */
it("closes an issue named only by a component commit's Closes trailer, once, through the issues.yml close provider", async () => {
  const world = await submoduleQueue()
  const pin = await componentCommit(world, "one: component work\n\nCloses: issue-component")
  const branch = "task/raise-one"
  await landRaise(world, branch, pin, "raise vendor/one\n\nRefs: unrelated-root-mention")
  await runQueue(world, branch, walked(branch))
  const merge = (await readStatus(world.store, "main", branch)).merge!
  expect(lines(world.closeCalls).map((line) => line.split("\t").slice(0, 2))).toEqual([
    ["issue-component", "completed"],
  ])
  // The component range starts at the old pin: a closing trailer already pinned before this landing is not re-read.
  expect(lines(world.resolveCalls)).toEqual(["issue-component"])
  const actions = attempts(world.workdir).flatMap(issueActions)
  expect(actions).toContainEqual(
    expect.objectContaining({ branch, mergeSha: merge, raw: "issue-component", status: "fulfilled" }),
  )
  expect(actions.filter(({ status }) => status === "failed" || status === "unavailable")).toEqual([])
}, 60000)

/** @failure A component commit's `Refs:` mention is treated as closing intent. @level l2 @consumer hh 29630 component-range close @testonly none */
it("closes nothing for a component commit that carries only a Refs trailer", async () => {
  const world = await submoduleQueue()
  const pin = await componentCommit(world, "one: mentions only\n\nRefs: issue-mentioned")
  const branch = "task/raise-refs"
  await landRaise(world, branch, pin, "raise vendor/one")
  await runQueue(world, branch, walked(branch))
  expect(lines(world.resolveCalls)).toEqual([])
  expect(lines(world.closeCalls)).toEqual([])
  const actions = attempts(world.workdir).flatMap(issueActions)
  expect(actions.filter(({ branch: named }) => named === branch).map(({ status }) => status)).not.toContain("failed")
}, 60000)

/** @failure One issue named by both the root and the component range is resolved or closed twice. @level l2 @consumer hh 29630 component-range close dedupe @testonly none */
it("closes an issue named by both a root commit and a component commit of one landing exactly once", async () => {
  const world = await submoduleQueue()
  const pin = await componentCommit(world, "one: shared work\n\nCloses: issue-shared")
  const branch = "task/raise-shared"
  await landRaise(world, branch, pin, "raise vendor/one\n\nCloses: issue-shared")
  await runQueue(world, branch, walked(branch))
  expect(lines(world.closeCalls).map((line) => line.split("\t")[0])).toEqual(["issue-shared"])
  expect(lines(world.resolveCalls)).toEqual(["issue-shared"])
}, 60000)

/** @failure A component range whose new pin the queue clone does not hold is skipped silently: its close is lost. @level l2 @consumer hh 29630 component-pin-unresolved refusal @testonly none */
it("fails the attempt by name when the queue clone's component store does not hold the new pin", async () => {
  const world = await submoduleQueue()
  // The new pin exists only in another clone of the component: the queue clone's submodule store never saw it.
  writeFileSync(join(world.root, "one-work", "one.txt"), "elsewhere\n")
  await world.upstream(["commit", "--quiet", "-am", "one: elsewhere\n\nCloses: issue-unreachable"])
  const pin = (await world.upstream(["rev-parse", "HEAD"])).trim()
  await expect(world.checkout(["cat-file", "-e", `${pin}^{commit}`])).rejects.toThrow()
  const branch = "task/raise-unheld"
  await landRaise(world, branch, pin, "raise vendor/one to an unheld pin")
  const failedByName = (attempt: Record<string, unknown>): boolean =>
    attempt.status === "failed" && issueActions(attempt).some((action) => action.reason === "component-pin-unresolved")
  const diagnostics = await runQueue(world, branch, (finished) => finished.some(failedByName))
  const merge = (await readStatus(world.store, "main", branch)).merge!
  const attempt = attempts(world.workdir).find(failedByName)!
  expect(issueActions(attempt)).toContainEqual(
    expect.objectContaining({
      branch,
      mergeSha: merge,
      status: "unavailable",
      reason: "component-pin-unresolved",
      component: COMPONENT,
      diagnostic: expect.stringContaining(`does not hold pin ${pin}`),
    }),
  )
  expect(diagnostics.join(" ")).toContain(`${branch}@${merge}: ${COMPONENT} moved`)
  // The diagnostic view keeps it: the segment's own fulfilled row must not share its identity.
  expect(readPostMergeIssueDiagnostics(world.workdir)).toContainEqual(
    expect.objectContaining({ branch, mergeSha: merge, providerId: `component:${COMPONENT}` }),
  )
  expect(lines(world.resolveCalls)).toEqual([])
  expect(lines(world.closeCalls)).toEqual([])
}, 60000)

/** @failure A resend after a human reopened an issue closes it again once the provider names it by a new key. @level l2 @consumer hh 29630 no-resend keyed on the merge (@cto baa5a4f1) @testonly none */
it("does not close a reopened issue again on a resend after the provider re-keys it", async () => {
  const world = await submoduleQueue()
  const pin = await componentCommit(world, "one: component work")
  const branch = "task/raise-rekey"
  await landRaise(world, branch, pin, "raise vendor/one\n\nCloses: issue-rekeyed")
  await runQueue(world, branch, walked(branch))
  expect(lines(world.resolveCalls)).toEqual(["issue-rekeyed"])
  expect(lines(world.closeCalls).map((line) => line.split("\t")[0])).toEqual(["issue-rekeyed"])
  // A human reopens it, and the provider now answers the same trailer value with another key.
  writeFileSync(world.rekey, "-new")
  const merge = (await readStatus(world.store, "main", branch)).merge!
  const config = await readConfig(world.git, merge, { remote: "origin", branch: "main" })
  if (config === undefined) throw Error("fixture queue lost config at the merge")
  const resend = join(world.root, "resend"),
    reports: string[] = []
  mkdirSync(resend)
  {
    await using runner = createPostMerge({
      workdir: resend,
      cwd: world.repo,
      git: world.git,
      store: world.store,
      cleanup: async () => {},
      report: (message) => reports.push(message),
    })
    runner.nudge({
      code: "fixture",
      config: config.blob,
      repo: world.repo,
      queue: "origin#main",
      target: merge,
      base: world.target,
      merged: [branch],
      projectRoot: world.repo,
      queueBranch: "main",
      remote: "origin",
    })
  }
  const [attempt] = attempts(resend)
  expect(attempt?.status, reports.join(" ")).toBe("succeeded")
  expect(issueActions(attempt!)).toContainEqual(
    expect.objectContaining({ branch, mergeSha: merge, status: "fulfilled" }),
  )
  // Answered from the merge's own record: no second close, and the provider is not even asked.
  expect(lines(world.closeCalls)).toHaveLength(1)
  expect(lines(world.resolveCalls)).toEqual(["issue-rekeyed"])
}, 60000)
