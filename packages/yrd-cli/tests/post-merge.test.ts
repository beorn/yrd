/**
 * @reach fs-walk <fixture-only: temporary provider and result directories>
 * @failure A blocked or failed issue close holds the merge line or skips Git cleanup; restart replays stored results.
 * @level l2
 * @consumer Yrd post-merge provider and cleanup lifecycle
 * @testonly none
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { chargedBranches, createPostMerge, readPostMergeIssueDiagnostics } from "../src/post-merge.ts"
import { coreQueueCommand, readEventListing } from "../src/queue-core-commands.ts"
import type { IssueEventLaunch, IssueEventLaunchInput } from "../src/issue-event-edge.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { Conflict, openEvents } from "../../yrd-queue-core/src/git.ts"
import { changeInput } from "../../yrd-queue-core/src/events.ts"
import {
  createEventQueue,
  changesRef,
  createEventStore,
  readBranchHistory,
  readEventQueue,
  issueProviderId,
  trailerEffectId,
  queueRef,
  readConfig,
  readStatus,
  submit,
  trailer,
  type GitRunner,
} from "@yrd/queue-core"
import { safeRemoveSync } from "removely"
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
})
type Attempt = {
  target: string
  exitCode: number
  status: string
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
}
const attemptAt = (path: string): Attempt => JSON.parse(readFileSync(path, "utf8")) as Attempt
const world = () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-post-"))
  roots.push(root)
  return root
}
const context = {
  code: "code-oid",
  config: "config-oid",
  repo: "fixture",
  queue: "origin#main",
  target: "merge-oid",
  merged: ["task/one"],
}
/** @failure Checkout cleanup starves a merged round's post-merge attempt until reload drops it. @level l2 @consumer Post-merge attempts and cleanup handoff @testonly none */
it.each(["drain", "stop"] as const)(
  "settles a merged round's post-merge attempt while earlier cleanup is held, then %s owns cleanup disposal",
  async (ending) => {
    const root = world()
    const settledStatus = (target: string) =>
      readdirSync(join(root, "post-merge"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => attemptAt(join(root, "post-merge", name)))
        .find((attempt) => attempt.target === target)?.status
    const release = Promise.withResolvers<void>()
    const started: string[] = []
    const finished: string[] = []
    const errors: string[] = []
    const stop = new AbortController()
    let active = 0
    let maxActive = 0
    const runner = createPostMerge({
      workdir: root,
      launchEvent: testLauncher,
      cwd: root,
      ...(ending === "stop" ? { stop: stop.signal } : {}),
      cleanup: async (c) => {
        active++
        maxActive = Math.max(maxActive, active)
        started.push(c.target)
        if (c.target === context.target) await release.promise
        finished.push(c.target)
        active--
      },
      report: (message) => errors.push(message),
    })
    let closing: Promise<void> | undefined
    try {
      runner.nudge(context)
      await vi.waitFor(() => expect(started).toEqual([context.target]), { timeout: 10000 })
      expect(settledStatus(context.target)).toBe("succeeded")
      runner.nudge({ ...context, target: "second", merged: ["task/two"] })
      // Observe the attempt's settled artifact, not merely a running one:
      // shutdown must occur after the second attempt completed.
      await vi.waitFor(() => expect(settledStatus("second")).toBe("succeeded"), { timeout: 10000 })
      expect(started).toEqual([context.target])
      expect(finished).toEqual([])
      if (ending === "stop") stop.abort()
      closing = runner[Symbol.asyncDispose]()
    } finally {
      release.resolve()
      await (closing ?? runner[Symbol.asyncDispose]())
    }
    expect(maxActive, "cleanup callbacks remain serial").toBe(1)
    expect(finished, "active cleanup finishes; a handoff skips unstarted cleanup").toEqual(
      ending === "stop" ? [context.target] : [context.target, "second"],
    )
    const dropped = errors.filter((message) => message.includes("task/two"))
    expect(dropped, "handoff reports exactly the unstarted cleanup context").toHaveLength(ending === "stop" ? 1 : 0)
  },
)
/**
 * `git` whose calls naming `held` mark `ready`, wait for `released`, then answer empty (no issues.yml there, so
 * the merged-event write skips); every other call runs. It holds one post-merge attempt open with no provider update.
 */
const holdingGit = (git: GitRunner, held: string, ready: string, released: Promise<void>): GitRunner =>
  new Proxy(git, {
    apply: async (target, _this, args: Parameters<GitRunner>) => {
      if (!args[0].includes(held)) return target(...args)
      writeFileSync(ready, "")
      await released
      return ""
    },
  })
/** @failure Stop silently drops coalesced merged branch names, so branch triage cannot recover pending cleanup. @level l2 @consumer Yrd service handoff @testonly none */
it.each(["drain", "stop", "close", "abort"] as const)(
  "coalesces catch-up behind a held attempt and names the coalesced branches on handoff (ending=%s)",
  async (ending) => {
    const root = world()
    const ready = join(root, "ready")
    const release = Promise.withResolvers<void>()
    const fixtureGit = gitIn(root)
    const cleaned: string[] = []
    const completed: string[] = []
    const errors: string[] = []
    const stop = new AbortController()
    await using runner = createPostMerge({
      workdir: root,
      launchEvent: testLauncher,
      cwd: root,
      // Only the first round reads Git: its merged-event write is the hold. Later rounds name no queueBranch.
      git: holdingGit(fixtureGit, context.target, ready, release.promise),
      store: createEventStore(root, "origin", fixtureGit.selection),
      ...(ending === "drain" ? {} : { stop: stop.signal }),
      cleanup: async (c) => {
        cleaned.push(c.target)
        await Promise.resolve()
        if (ending === "stop") stop.abort()
        completed.push(c.target)
      },
      report: (s) => errors.push(s),
    })
    runner.nudge({ ...context, base: "first-base", queueBranch: "main", remote: "origin" })
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10000 })
    runner.nudge({ ...context, target: "second", merged: ["task/two"] })
    runner.nudge({ ...context, target: "third", merged: ["task/three", "task/two"] })
    expect(cleaned).toEqual([])
    let closing: Promise<void> | undefined
    if (ending === "close") closing = runner[Symbol.asyncDispose]()
    if (ending === "abort") stop.abort()
    release.resolve()
    if (ending === "stop") {
      await vi.waitFor(() => expect(completed).toEqual(["merge-oid"]), { timeout: 10000 })
      // Observe pump's stop reporting before invoking close, which has its own
      // pending-context drop path. Both must report one coalesced set of names.
      await vi.waitFor(
        () => expect(errors.filter((line) => line.includes("task/two") || line.includes("task/three"))).toHaveLength(1),
        { timeout: 1500 },
      )
    }
    await (closing ?? runner[Symbol.asyncDispose]())
    if (ending !== "drain") {
      expect(cleaned, "pending cleanup does not run after handoff").toEqual(ending === "abort" ? [] : ["merge-oid"])
      expect(completed, "active cleanup finishes before disposal returns").toEqual(
        ending === "abort" ? [] : ["merge-oid"],
      )
      const dropped = errors.filter((line) => line.includes("task/two") || line.includes("task/three"))
      expect(dropped, "one report identifies the coalesced pending branches").toHaveLength(1)
      expect(dropped[0]).toContain("task/two")
      expect(dropped[0]).toContain("task/three")
      if (ending === "abort") {
        expect(errors.some((line) => line.includes("task/one") && line.includes("cleanup dropped"))).toBe(true)
      }
      return
    }
    expect(cleaned).toEqual(["merge-oid", "third"])
    const results = readdirSync(join(root, "post-merge"))
      .filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(join(root, "post-merge", n), "utf8")) as Attempt & { merged: string[] })
      .sort((a, b) => (a.target === "merge-oid" ? -1 : b.target === "merge-oid" ? 1 : 0))
    expect(results).toEqual([
      expect.objectContaining({ target: "merge-oid", merged: ["task/one"], cwd: root, status: "succeeded" }),
      expect.objectContaining({ target: "third", merged: ["task/two", "task/three"], status: "succeeded" }),
    ])
  },
)
it("labels interrupted evidence and starts a fresh catch-up without consulting old output", async () => {
  const root = world()
  const cleaned: string[] = []
  {
    await using runner = createPostMerge({
      workdir: root,
      launchEvent: testLauncher,
      cwd: root,
      cleanup: async (c) => {
        cleaned.push(c.target)
      },
      report: () => {},
    })
    runner.nudge(context)
    await runner[Symbol.asyncDispose]()
  }
  const path = join(
    root,
    "post-merge",
    readdirSync(join(root, "post-merge")).find((n) => n.endsWith(".json"))!,
  )
  const old = attemptAt(path)
  writeFileSync(path, JSON.stringify({ ...old, status: "running", endedAt: undefined }))
  await using restarted = createPostMerge({
    workdir: root,
    launchEvent: testLauncher,
    cwd: root,
    cleanup: async (c) => {
      cleaned.push(c.target)
    },
    report: () => {},
  })
  restarted.recover()
  restarted.nudge({ ...context, target: "startup" })
  await restarted[Symbol.asyncDispose]()
  expect(attemptAt(path).status).toBe("interrupted")
  expect(cleaned).toEqual(["merge-oid", "startup"])
})
/** @failure An enabled writer silently skips closes when its queue dependencies are missing. @level l2 @consumer post-merge attempts */
it("records every missing input for explicitly enabled automatic issue closing", async () => {
  const root = world()
  const errors: string[] = []
  const cleaned: string[] = []
  await using runner = createPostMerge({
    workdir: root,
    launchEvent: testLauncher,
    cwd: root,
    cleanup: async (c) => {
      cleaned.push(c.target)
    },
    report: (message) => errors.push(message),
  })
  runner.nudge({ ...context, projectRoot: root })
  await runner[Symbol.asyncDispose]()
  expect(cleaned).toEqual([context.target])
  const [attempt] = readdirSync(join(root, "post-merge"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(root, "post-merge", name), "utf8")))
  expect(attempt).toMatchObject({ status: "unavailable" })
  for (const name of ["git", "store", "queueBranch"]) {
    expect(attempt).toMatchObject({ reason: expect.stringContaining(name) })
    expect(errors.join(" ")).toContain(name)
  }
})

/** @failure An unwritable evidence directory skips the round's issue close or its Git cleanup. @level l2 @consumer post-merge attempts @testonly none */
it("attempts the issue close and cleanup even when its derived artifact directory is unwritable", async () => {
  const root = world()
  writeFileSync(join(root, "post-merge"), "occupied by a file")
  const cleaned: string[] = [],
    reports: string[] = []
  await using runner = createPostMerge({
    workdir: root,
    launchEvent: testLauncher,
    cwd: root,
    cleanup: async (c) => {
      cleaned.push(c.target)
    },
    report: (s) => reports.push(s),
  })
  runner.nudge({ ...context, projectRoot: root })
  await runner[Symbol.asyncDispose]()
  // The closer was reached: an explicit projectRoot without the queue's inputs is refused out loud.
  expect(reports.join(" ")).toContain(`automatic issue close unavailable: explicit projectRoot ${root}`)
  expect(cleaned).toEqual(["merge-oid"])
  expect(reports.join(" ")).toContain("post-merge evidence unavailable")
  const unread: string[] = []
  expect(readPostMergeIssueDiagnostics(root, (message) => unread.push(message))).toEqual([])
  expect(unread.join(" ")).toContain(join(root, "post-merge"))
})

it.each([
  { mode: "completion" },
  { mode: "close-stop" },
  { mode: "append-conflict" },
  { mode: "append-error" },
  { mode: "append-lost-reply" },
  { mode: "concurrent" },
  { mode: "cold-replay" },
  { mode: "declaration-edit" },
  { mode: "delivered-declaration" },
  { mode: "reuse-pending" },
  { mode: "reuse-legacy" },
  { mode: "reuse-predeclaration" },
  { mode: "blob-mismatch" },
  { mode: "observed-ff" },
  { mode: "observed-after-target" },
  { mode: "observed-stacked" },
  { mode: "observed-stacked-merge" },
  { mode: "observed-merge" },
  { mode: "observed-legacy" },
  { mode: "provider-lost-reply" },
  { mode: "resolve-retry" },
  { mode: "walk-retry" },
] as const)(
  "preserves the real merge queue while exercising post-merge $mode behavior",
  async ({ mode }) => {
    const reconcileAfterQueue =
      mode.startsWith("append-") ||
      mode === "reuse-pending" ||
      mode === "reuse-legacy" ||
      mode === "reuse-predeclaration" ||
      mode === "concurrent" ||
      mode === "provider-lost-reply" ||
      mode === "resolve-retry" ||
      mode === "walk-retry" ||
      mode === "observed-legacy"
    const expectedCloses = mode === "observed-stacked-merge" ? 4 : mode.startsWith("observed-") ? 3 : 2
    const root = world(),
      remote = join(root, "remote.git"),
      repo = join(root, "author"),
      workdir = join(root, "queue")
    mkdirSync(workdir)
    const seed = gitIn(root)
    await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
    await seed(["clone", "--quiet", remote, repo])
    const git = gitIn(repo),
      closeCalls = join(root, "close-calls.jsonl"),
      closeReady = join(root, "close-ready"),
      closeRelease = join(root, "close-release"),
      resolveCalls = join(root, "resolve-calls")
    await git(["config", "user.email", "provider@yrd.test"])
    await git(["config", "user.name", "fixture"])
    await git(["checkout", "--quiet", "-b", "main"])
    const fakeProvider = join(import.meta.dirname, "support", "fake-issues-provider.ts")
    const closeScript =
      (mode === "close-stop" ? 'printf "%s" "$$" > "$5"; while ! test -f "$6"; do sleep .05; done; ' : "") +
      'printf "%s\\t%s\\t%s\\n" "$1" "$2" "$3" >> "$4"; ' +
      (mode === "concurrent" ? 'while ! test -f "$6"; do sleep .05; done; ' : "") +
      (mode === "provider-lost-reply"
        ? 'if ! test -f "$5"; then touch "$5"; exit 7; fi; printf \'{"noChange":true}\\n\''
        : "printf '{\"applied\":true}\\n'")
    writeFileSync(join(repo, ".yrd.yml"), JSON.stringify({}))
    writeFileSync(
      join(repo, "issues.yml"),
      JSON.stringify({
        resolve:
          mode === "resolve-retry"
            ? [
                "sh",
                "-c",
                'if ! test -f "$2"; then touch "$2"; exit 7; fi; printf \'{"keys":["resolved-%s"]}\\n\' "$1"',
                "resolve",
                "<raw>",
                join(root, "resolve-failed"),
              ]
            : mode === "blob-mismatch" || mode === "observed-legacy"
              ? [
                  "sh",
                  "-c",
                  'printf "%s\\n" "$1" >> "$2"; printf \'{"keys":["%s"]}\\n\' "$1"',
                  "resolve",
                  "<raw>",
                  resolveCalls,
                ]
              : [process.execPath, fakeProvider, "resolve", "<raw>"],
        close: ["sh", "-c", closeScript, "close", "<key>", "<reason>", "<id>", closeCalls, closeReady, closeRelease],
      }),
    )
    const issueDeclaration = readFileSync(join(repo, "issues.yml"), "utf8")
    if (mode === "reuse-predeclaration") unlinkSync(join(repo, "issues.yml"))
    await git(["add", ".yrd.yml", ...(mode === "reuse-predeclaration" ? [] : ["issues.yml"])])
    await git(["commit", "--quiet", "-m", "queue"])
    await git(["push", "--quiet", "origin", "main"])
    const target = (await git(["rev-parse", "HEAD"])).trim(),
      config = await readConfig(git, target, { remote: "origin", branch: "main" })
    if (config === undefined) throw Error("fixture queue lost config")
    const store = createEventStore(repo, "origin", git.selection)
    const queueTip = await createEventQueue(store, "main", target, config, new Date())
    const queue = async (branch: string, message: string) => {
      await git(["checkout", "--quiet", "-b", branch, "origin/main"])
      if (mode === "reuse-predeclaration" && branch === "task/second") {
        writeFileSync(join(repo, "issues.yml"), issueDeclaration)
      }
      writeFileSync(join(repo, branch.replaceAll("/", "-") + ".txt"), branch)
      if ((mode === "observed-ff" || mode === "observed-after-target") && branch === "task/first") {
        writeFileSync(join(repo, "older.txt"), "older closing intent")
        await git(["add", "older.txt"])
        await git(["commit", "--quiet", "-m", "older\n\nCloses: issue-older"])
      }
      if (mode === "delivered-declaration" && branch === "task/first") {
        writeFileSync(
          join(repo, "issues.yml"),
          JSON.stringify({
            resolve: ["sh", "-c", 'printf \'{"keys":["delivered-%s"]}\\n\' "$1"', "resolve", "<raw>"],
            close: [
              "sh",
              "-c",
              closeScript,
              "close",
              "<key>",
              "<reason>",
              "<id>",
              closeCalls,
              closeReady,
              closeRelease,
            ],
          }),
        )
      }
      await git(["add", "."])
      await git(["commit", "--quiet", "-m", message])
      if (
        (mode === "observed-legacy" ||
          mode === "reuse-legacy" ||
          mode === "reuse-predeclaration" ||
          mode === "observed-ff" ||
          mode === "observed-after-target" ||
          mode === "observed-stacked" ||
          mode === "observed-stacked-merge") &&
        branch === "task/first"
      ) {
        const head = (await git(["rev-parse", "HEAD"])).trim()
        await git(["push", "--quiet", "origin", branch])
        // These are historical opened records: preserve the source range as it existed before the
        // one-binding submit reader, rather than asking current submit to admit multiple Closes keys.
        const hasRecordedBase =
          mode === "observed-ff" ||
          mode === "observed-after-target" ||
          mode === "observed-stacked" ||
          mode === "observed-stacked-merge"
        await (
          await openEvents({ ...store, ref: changesRef("main", branch) })
        ).append(
          [
            changeInput("opened", {
              queueTip,
              at: new Date(),
              commit: head,
              by: "fixture",
              ...(hasRecordedBase ? { base: queueTip } : {}),
            }),
          ],
          { expect: null },
        )
        await git(["checkout", "--quiet", "main"])
        return
      }
      const submitted = await submit(git, "origin", {
        branch,
        submitter: "fixture",
        target: { remote: "origin", branch: "main" },
      })
      await git(["checkout", "--quiet", "main"])
      return submitted
    }
    await queue("task/first", "first\n\nCloses: issue-first")
    const firstSubmittedHead = (await git(["rev-parse", "task/first"])).trim()
    let firstObservedMerge = firstSubmittedHead
    if (mode === "observed-stacked" || mode === "observed-stacked-merge") {
      await git(["checkout", "--quiet", "-b", "task/aa-stacked", "task/first"])
      writeFileSync(join(repo, "stacked.txt"), "upper source")
      await git(["add", "stacked.txt"])
      await git(["commit", "--quiet", "-m", "upper\n\nCloses: issue-stacked"])
      const stackedHead = (await git(["rev-parse", "HEAD"])).trim()
      await git(["push", "--quiet", "origin", "task/aa-stacked"])
      await (
        await openEvents({ ...store, ref: changesRef("main", "task/aa-stacked") })
      ).append(
        [
          changeInput("opened", {
            queueTip,
            at: new Date(),
            commit: stackedHead,
            by: "fixture",
            base: firstSubmittedHead,
          }),
        ],
        { expect: null },
      )
      await git(["checkout", "--quiet", "main"])
      if (mode === "observed-stacked-merge") {
        await git([
          "merge",
          "--quiet",
          "--no-ff",
          "task/aa-stacked",
          "-m",
          "deliver the whole stack\n\nCloses: issue-merge",
        ])
        firstObservedMerge = (await git(["rev-parse", "HEAD"])).trim()
        await git(["push", "--quiet", "origin", "main"])
      } else {
        await git(["push", "--quiet", "origin", "task/aa-stacked:refs/heads/main"])
      }
    } else if (mode === "observed-merge") {
      writeFileSync(join(repo, "unrelated.txt"), "target-only intent")
      await git(["add", "unrelated.txt"])
      await git(["commit", "--quiet", "-m", "target work\n\nCloses: issue-unrelated"])
      await git(["merge", "--quiet", "--no-ff", "task/first", "-m", "delivery\n\nCloses: issue-merge"])
      firstObservedMerge = (await git(["rev-parse", "HEAD"])).trim()
      writeFileSync(join(repo, "later.txt"), "later target-only intent")
      await git(["add", "later.txt"])
      await git(["commit", "--quiet", "-m", "later work\n\nCloses: issue-later-unrelated"])
      await git(["push", "--quiet", "origin", "main"])
    } else if (mode.startsWith("observed-") || mode === "reuse-legacy" || mode === "reuse-predeclaration") {
      await git(["push", "--quiet", "origin", "task/first:refs/heads/main"])
      if (mode === "observed-after-target") {
        await git(["merge", "--quiet", "--ff-only", "origin/main"])
        writeFileSync(join(repo, "unrelated.txt"), "later target commit")
        await git(["add", "unrelated.txt"])
        await git(["commit", "--quiet", "-m", "unrelated\n\nCloses: issue-unrelated"])
        await git(["push", "--quiet", "origin", "main"])
      }
    }
    const stop = new AbortController(),
      merged: string[] = [],
      diagnostics: string[] = []
    // Each follow-on branch is queued exactly once. The rounds are fast now that the merged event leaves with a child
    // (hh #38766), so an afterRound can fire again between a submit and its merge; without this the fixture tried to
    // create the same branch twice and failed on its own name.
    const queued = new Set<string>()
    const queueOnce = async (branch: string, message: string): Promise<void> => {
      if (queued.has(branch)) return
      queued.add(branch)
      await queue(branch, message)
    }
    let rounds = 0
    try {
      expect(
        await coreQueueCommand(
          repo,
          {
            cwd: repo,
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
              if (mode.startsWith("observed-") && merged.includes("task/first")) {
                expect((await readStatus(store, "main", "task/first")).merge).toBe(firstObservedMerge)
              }
              if (merged.includes("task/first") && !merged.includes("task/second")) {
                await queueOnce("task/second", "second\n\nCloses: issue-second")
              }
              if (merged.includes("task/second") && !merged.includes("task/refs")) {
                await queueOnce(
                  "task/refs",
                  "mentions only\n\nFixes everything\n\nCloses issue-colonless\n\nRefs: issue-refs",
                )
              }
              if (merged.includes("task/refs")) {
                if (reconcileAfterQueue) {
                  stop.abort()
                  return
                }
                if (mode === "close-stop") {
                  await vi.waitFor(() => expect(existsSync(closeReady)).toBe(true), { timeout: 10000 })
                  stop.abort("queue shutdown fixture")
                  return
                }
                await vi.waitFor(
                  () => {
                    const calls = existsSync(closeCalls)
                      ? readFileSync(closeCalls, "utf8").trim().split("\n").filter(Boolean)
                      : []
                    expect(calls, diagnostics.join(" ")).toHaveLength(expectedCloses)
                  },
                  { timeout: 5000 },
                )
                // A provider call can finish before its queue fact is published; shutdown must wait for custody.
                await vi.waitFor(
                  async () => {
                    expect(Object.keys((await readEventQueue(store, "main")).issueEffects)).toHaveLength(expectedCloses)
                  },
                  { timeout: 5000 },
                )
                stop.abort()
              } else if (rounds > 3) stop.abort()
            },
          },
          {
            workdir,
            json: true,
            launchEvent: testLauncher,
            ...(reconcileAfterQueue ? {} : { projectRoot: repo }),
          },
        ),
        diagnostics.join(" "),
      ).toBe(0)
    } finally {
      stop.abort()
    }
    if (mode === "observed-stacked-merge") {
      const before = readFileSync(closeCalls, "utf8").trim().split("\n")
      expect(before.map((line) => line.split("\t")[0]).sort()).toEqual([
        "issue-first",
        "issue-merge",
        "issue-second",
        "issue-stacked",
      ])
      expect((await readStatus(store, "main", "task/aa-stacked")).merge).toBe(firstObservedMerge)
      await using runner = createPostMerge({
        workdir,
        launchEvent: testLauncher,
        cwd: repo,
        git,
        store,
        cleanup: async () => {},
        report: (message) => diagnostics.push(message),
      })
      runner.nudge({
        ...context,
        target: firstObservedMerge,
        merged: ["task/aa-stacked"],
        projectRoot: repo,
        queueBranch: "main",
      })
      await runner[Symbol.asyncDispose]()
      expect(
        readFileSync(closeCalls, "utf8").trim().split("\n"),
        "an upper-only rerun must not repeat any already delivered issue close",
      ).toEqual(before)
      return
    }
    if (mode === "observed-legacy") {
      const before = (await readBranchHistory(store, "main", "task/first")).history!
      expect(before.state.status).toBe("merged")
      expect(
        trailer(
          before.events.find((event) => event.type === "opened")!,
          "Base",
        ),
      ).toBeUndefined()
      expect(
        trailer(
          before.events.find((event) => event.type === "merged")!,
          "Base",
        ),
      ).toBeUndefined()
      await using runner = createPostMerge({
        workdir,
        launchEvent: testLauncher,
        cwd: repo,
        git,
        store,
        cleanup: async () => {},
        report: (message) => diagnostics.push(message),
      })
      runner.nudge({
        ...context,
        target: firstObservedMerge,
        merged: ["task/first"],
        projectRoot: repo,
        queueBranch: "main",
      })
      await runner[Symbol.asyncDispose]()
      expect(existsSync(closeCalls)).toBe(false)
      expect(existsSync(resolveCalls)).toBe(false)
      expect(diagnostics.join(" ")).toContain("no provable historical base")
      expect((await readBranchHistory(store, "main", "task/first")).history!.state).toEqual(before.state)
      return
    }
    if (mode === "walk-retry") {
      // History and segment failures have no provider identity. A clean retry
      // must clear both without hiding failures while their walks are incomplete.
      const second = (await readBranchHistory(store, "main", "task/second")).history!
      const fetchRefs = store.backend.fetchRefs
      if (fetchRefs === undefined) throw new Error("fixture lacks existing fetch seam")
      const faultStore = {
        ...store,
        backend: {
          ...store.backend,
          fetchRefs: async (...args: Parameters<typeof fetchRefs>) => {
            if (args[1].includes(changesRef("main", "task/first"))) {
              throw new Error("fixture transient history read failure")
            }
            return fetchRefs(...args)
          },
        },
      }
      const faultGit = new Proxy(git, {
        apply: (target, _this, args: Parameters<typeof git>) => {
          if (args[0][0] === "ls-tree" && args[0].includes(second.state.merge!)) {
            throw new Error("fixture transient segment read failure")
          }
          return target(...args)
        },
      })
      for (let retry = 0; retry < 2; retry++) {
        await using runner = createPostMerge({
          workdir,
          launchEvent: testLauncher,
          cwd: repo,
          git: retry === 0 ? faultGit : git,
          store: retry === 0 ? faultStore : store,
          cleanup: async () => {},
          report: (message) => diagnostics.push(message),
        })
        runner.nudge({
          ...context,
          target: second.state.merge!,
          merged: ["task/first", "task/second"],
          projectRoot: repo,
          queueBranch: "main",
        })
        await runner[Symbol.asyncDispose]()
        if (retry === 0) {
          expect(readPostMergeIssueDiagnostics(workdir)).toEqual([
            expect.objectContaining({
              branch: "task/first",
              mergedEvent: "",
              providerId: "",
              diagnostic: expect.stringContaining("transient history read failure"),
            }),
            expect.objectContaining({
              branch: "task/second",
              mergedEvent: second.state.ending!.id,
              providerId: "",
              diagnostic: expect.stringContaining("transient segment read failure"),
            }),
          ])
          expect(existsSync(closeCalls)).toBe(false)
        }
      }
      expect(readPostMergeIssueDiagnostics(workdir)).toEqual([])
      expect(
        readFileSync(closeCalls, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("\t")[0]),
      ).toEqual(["issue-first", "issue-second"])
      return
    }
    if (mode === "resolve-retry") {
      const history = (await readBranchHistory(store, "main", "task/first")).history!
      for (let retry = 0; retry < 2; retry++) {
        await using runner = createPostMerge({
          workdir,
          launchEvent: testLauncher,
          cwd: repo,
          git,
          store,
          cleanup: async () => {},
          report: (message) => diagnostics.push(message),
        })
        runner.nudge({
          ...context,
          target: history.state.merge!,
          merged: ["task/first"],
          projectRoot: repo,
          queueBranch: "main",
        })
        await runner[Symbol.asyncDispose]()
        if (retry === 0) {
          expect(readPostMergeIssueDiagnostics(workdir)).toContainEqual(
            expect.objectContaining({ branch: "task/first", diagnostic: expect.stringContaining("exit 7") }),
          )
        }
      }
      expect(readFileSync(closeCalls, "utf8").trim().split("\n")).toHaveLength(1)
      expect(readFileSync(closeCalls, "utf8")).toContain("resolved-issue-first\tcompleted")
      expect(readPostMergeIssueDiagnostics(workdir)).toEqual([])
      const listing = await readEventListing(
        git,
        config,
        repo,
        workdir,
        (await git(["rev-parse", "origin/main"])).trim(),
        store,
        { all: true },
      )
      expect(listing.all.find((row) => row.branch === "task/first")?.diagnostic ?? "").not.toContain("exit 7")
      return
    }
    if (mode === "provider-lost-reply") {
      const mergedReading = await readBranchHistory(store, "main", "task/first")
      const action = {
        ...context,
        target: mergedReading.history!.state.merge!,
        merged: ["task/first"],
        projectRoot: repo,
        queueBranch: "main",
      }
      for (let restart = 0; restart < 3; restart++) {
        await using runner = createPostMerge({
          workdir,
          launchEvent: testLauncher,
          cwd: repo,
          git,
          store,
          cleanup: async () => {},
          report: (message) => diagnostics.push(message),
        })
        runner.nudge(action)
        await runner[Symbol.asyncDispose]()
        const { history } = await readBranchHistory(store, "main", "task/first")
        expect(Object.values((await readEventQueue(store, "main")).issueEffects)).toHaveLength(restart === 0 ? 0 : 1)
        expect(history!.state.status).toBe("merged")
      }
      expect(existsSync(closeReady), "provider applied before its first failed reply").toBe(true)
      expect(diagnostics.join(" ")).toContain("provider ended with exit 7")
      const calls = readFileSync(closeCalls, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("\t"))
      expect(calls).toHaveLength(2)
      expect(calls[0]).toEqual(calls[1])
      expect(readPostMergeIssueDiagnostics(workdir)).toEqual([])
      return
    }
    if (mode === "reuse-pending" || mode === "reuse-legacy" || mode === "reuse-predeclaration") {
      const old = await readBranchHistory(store, "main", "task/first")
      const mergeSha = old.history!.state.merge!
      const mergedEvent = old.history!.state.ending!.id
      if (store.backend.publish === undefined) throw new Error("fixture lacks cold custody publisher")
      await store.backend.publish(
        store.repo,
        [
          { ref: "refs/yrd-archive/main/task/first", expect: "0".repeat(40), oid: old.history!.state.tip! },
          { ref: old.ref, expect: old.history!.state.tip!, oid: null },
        ],
        "origin",
      )
      await git(["checkout", "--quiet", "task/first"])
      await git(["merge", "--quiet", "--ff-only", "origin/main"])
      writeFileSync(join(repo, "new-generation.txt"), "new work remains queued")
      await git(["add", "new-generation.txt"])
      await git(["commit", "--quiet", "-m", "new generation without closing intent"])
      await submit(git, "origin", {
        branch: "task/first",
        submitter: "fixture",
        target: { remote: "origin", branch: "main" },
      })
      await git(["checkout", "--quiet", "main"])
      const before = (await readBranchHistory(store, "main", "task/first")).history!.state
      expect(before.status).toBe("queued")
      const previousAttempts = new Set(readdirSync(join(workdir, "post-merge")))
      await using runner = createPostMerge({
        workdir,
        launchEvent: testLauncher,
        cwd: repo,
        git,
        store,
        cleanup: async () => {},
        report: (message) => diagnostics.push(message),
      })
      runner.nudge({
        ...context,
        target: (await git(["rev-parse", "origin/main"])).trim(),
        base: (await git(["rev-parse", "origin/main"])).trim(),
        merged: ["task/first", "task/second"],
        projectRoot: repo,
        queueBranch: "main",
      })
      await runner[Symbol.asyncDispose]()
      const after = (await readBranchHistory(store, "main", "task/first")).history!
      expect(after.state).toEqual(before)
      const applied = Object.values((await readEventQueue(store, "main")).issueEffects).map(({ effect }) => effect)
      if (mode !== "reuse-pending") {
        const attempts = readdirSync(join(workdir, "post-merge"))
          .filter((name) => name.endsWith(".json") && !previousAttempts.has(name))
          .map(
            (name) =>
              JSON.parse(readFileSync(join(workdir, "post-merge", name), "utf8")) as {
                status: string
                issueActions: Record<string, unknown>[]
              },
          )
        expect(attempts).toHaveLength(1)
        const legacy = attempts[0]!.issueActions.find((action) => action.mergedEvent === mergedEvent)
        expect(legacy).toMatchObject({
          branch: "task/first",
          mergedEvent,
          mergeSha,
          status: mode === "reuse-predeclaration" ? "skipped" : "failed",
        })
        expect(applied.some((effect) => effect.mergedEvent === mergedEvent)).toBe(false)
        const second = (await readBranchHistory(store, "main", "task/second")).history!
        expect(applied).toContainEqual(
          expect.objectContaining({
            mergedEvent: second.state.ending!.id,
            mergeSha: second.state.merge,
            issueKey: "issue-second",
            mergeCommitterTime: new Date(
              (await git(["show", "-s", "--format=%cI", second.state.merge!])).trim(),
            ).toISOString(),
          }),
        )
        expect(
          readFileSync(closeCalls, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split("\t")[0]),
        ).toEqual(["issue-second"])
        if (mode === "reuse-legacy") {
          expect(attempts[0]!.status).toBe("failed")
          expect(legacy).toMatchObject({ raw: "issue-first" })
          const listing = await readEventListing(
            git,
            config,
            repo,
            workdir,
            (await git(["rev-parse", "origin/main"])).trim(),
            store,
            { all: true },
          )
          expect(listing.all.find((row) => row.branch === "task/first")?.diagnostic).toContain(
            "no provable historical base",
          )
        }
        return
      }
      expect(applied).toContainEqual(
        expect.objectContaining({ mergedEvent, mergeSha, issueKey: "issue-first", semanticEnding: "completed" }),
      )
      expect(
        readFileSync(closeCalls, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("\t")[0]),
      ).toEqual(["issue-first", "issue-second"])
      return
    }
    if (mode === "concurrent") {
      await using first = createPostMerge({
        workdir,
        launchEvent: testLauncher,
        cwd: repo,
        git,
        store,
        cleanup: async () => {},
        report: (message) => diagnostics.push(message),
      })
      await using second = createPostMerge({
        workdir,
        launchEvent: testLauncher,
        cwd: repo,
        git,
        store,
        cleanup: async () => {},
        report: (message) => diagnostics.push(message),
      })
      const action = {
        ...context,
        target: (await git(["rev-parse", "origin/main"])).trim(),
        merged: ["task/first"],
        projectRoot: repo,
        queueBranch: "main",
      }
      first.nudge(action)
      second.nudge(action)
      await vi.waitFor(
        () => {
          expect(existsSync(closeCalls)).toBe(true)
          expect(readFileSync(closeCalls, "utf8").trim().split("\n")).toHaveLength(2)
        },
        { timeout: 10000 },
      )
      const calls = readFileSync(closeCalls, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("\t"))
      expect(calls[0]).toEqual(calls[1])
      writeFileSync(closeRelease, "go")
      await Promise.all([first[Symbol.asyncDispose](), second[Symbol.asyncDispose]()])
      const effects = Object.values((await readEventQueue(store, "main")).issueEffects).map(({ effect }) => effect)
      expect(effects).toHaveLength(1)
      // The provider's replay id is per key; the merge's own record is keyed on the trailer value it carried (29630).
      const [effect] = effects
      expect(effect!.issueKey).toBe(calls[0]![0])
      expect(calls[0]![2]).toBe(issueProviderId(effect!.mergeSha, "close", "completed", effect!.issueKey))
      expect(effect!.providerId).toBe(trailerEffectId(effect!.mergeSha, "close", "completed", effect!.trailer!))
      expect(readFileSync(closeCalls, "utf8").trim().split("\n")).toHaveLength(2)
      expect(diagnostics.join(" ")).not.toContain("could not be recorded")
      return
    }
    if (mode === "append-conflict" || mode === "append-error" || mode === "append-lost-reply") {
      const publish = store.backend.publish
      if (publish === undefined) throw new Error("fixture lacks existing publish seam")
      let firstAppends = 0
      const fault =
        mode === "append-conflict"
          ? new Conflict("fixture CAS lost", { refs: [queueRef("main")] })
          : new Error("fixture permanent append failure")
      const faultStore = {
        ...store,
        backend: {
          ...store.backend,
          publish: async (...args: Parameters<typeof publish>) => {
            // Only the first provider action loses its publication; the second still records normally.
            if (
              args[1].some((update) => update.ref === queueRef("main")) &&
              readFileSync(closeCalls, "utf8").trim().split("\n").length === 1
            ) {
              firstAppends++
              if (mode === "append-lost-reply" && firstAppends === 1) {
                await publish(...args)
                throw new Error("fixture publish landed but response was lost")
              }
              if (mode === "append-error" || firstAppends === 1) throw fault
            }
            return publish(...args)
          },
        },
      }
      await using runner = createPostMerge({
        workdir,
        launchEvent: testLauncher,
        cwd: repo,
        git,
        store: faultStore,
        cleanup: async () => {},
        report: (message) => diagnostics.push(message),
      })
      runner.nudge({
        ...context,
        target: (await git(["rev-parse", "origin/main"])).trim(),
        merged: ["task/first", "task/second"],
        projectRoot: repo,
        queueBranch: "main",
      })
      await runner[Symbol.asyncDispose]()
      expect(firstAppends).toBe(mode === "append-conflict" ? 2 : 1)
      const { history } = await readBranchHistory(store, "main", "task/first")
      expect(
        Object.values((await readEventQueue(store, "main")).issueEffects).filter(
          ({ effect }) => effect.mergedEvent === history!.state.ending!.id,
        ),
      ).toHaveLength(mode === "append-error" ? 0 : 1)
      expect(readFileSync(closeCalls, "utf8").trim().split("\n")).toHaveLength(2)
      if (mode === "append-error") expect(diagnostics.join(" ")).toContain("fixture permanent append failure")
      return
    }
    if (mode === "close-stop") {
      const pid = Number(readFileSync(closeReady, "utf8"))
      expect(pid).toBeGreaterThan(0)
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
      expect(diagnostics.join(" ")).toContain("stopped: queue shutdown fixture")
      expect((await readEventQueue(store, "main")).issueEffects).toEqual({})
      for (const branch of ["task/first", "task/second"]) {
        const { history } = await readBranchHistory(store, "main", branch)
        expect(history!.events.flatMap((event) => trailer(event, "Issue-Effect") ?? [])).toEqual([])
        expect(history!.state.status).toBe("merged")
      }
      expect(existsSync(closeCalls)).toBe(false)
      const failedAction = readdirSync(join(workdir, "post-merge"))
        .filter((name) => name.endsWith(".json"))
        .flatMap(
          (name) =>
            (
              JSON.parse(readFileSync(join(workdir, "post-merge", name), "utf8")) as {
                issueActions: Array<{ branch: string; providerId: string; status: string }>
              }
            ).issueActions,
        )
        .find((action) => action.branch === "task/first" && action.status === "failed")
      expect(failedAction).toBeDefined()
      expect(readPostMergeIssueDiagnostics(workdir)).toContainEqual(
        expect.objectContaining({
          branch: "task/first",
          providerId: failedAction!.providerId,
        }),
      )
      const deliveredTarget = (await git(["rev-parse", "origin/main"])).trim()
      const failedListing = await readEventListing(git, config, repo, workdir, deliveredTarget, store, { all: true })
      expect(failedListing.all.find((row) => row.branch === "task/first")?.diagnostic).toContain(
        "stopped: queue shutdown fixture",
      )
      const failedPath = readdirSync(join(workdir, "post-merge"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => join(workdir, "post-merge", name))
        .find((path) =>
          (JSON.parse(readFileSync(path, "utf8")) as { issueActions: Array<{ providerId: string }> }).issueActions.some(
            (action) => action.providerId === failedAction!.providerId,
          ),
        )!
      const failedEvidence = JSON.parse(readFileSync(failedPath, "utf8")) as {
        issueActions: Array<{ diagnostic?: string }>
      }
      for (const action of failedEvidence.issueActions) {
        if (action.diagnostic !== undefined) action.diagnostic += "; updated after cache warm"
      }
      writeFileSync(failedPath, JSON.stringify(failedEvidence))
      const refreshedListing = await readEventListing(git, config, repo, workdir, deliveredTarget, store, { all: true })
      expect(refreshedListing.all.find((row) => row.branch === "task/first")?.diagnostic).toContain(
        "updated after cache warm",
      )
      const environments = join(workdir, "environments")
      mkdirSync(environments, { recursive: true })
      for (const branch of ["first", "second", "refs"]) {
        await git(["worktree", "add", "--quiet", join(environments, branch), `task/${branch}`])
      }
      writeFileSync(closeRelease, "go")
      const retryStop = new AbortController()
      expect(
        await coreQueueCommand(
          repo,
          {
            cwd: repo,
            stdout: () => {},
            stderr: (message) => diagnostics.push(message),
            localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
          },
          {
            command: "up",
            intervalSeconds: 0,
            stop: retryStop.signal,
            afterRound: async () => {
              await vi.waitFor(
                async () => {
                  for (const branch of ["task/first", "task/second"]) {
                    const { history } = await readBranchHistory(store, "main", branch)
                    expect(
                      Object.values((await readEventQueue(store, "main")).issueEffects).filter(
                        ({ effect }) => effect.mergedEvent === history!.state.ending!.id,
                      ),
                    ).toHaveLength(1)
                  }
                },
                { timeout: 10000 },
              )
              retryStop.abort()
            },
          },
          { workdir, json: true, launchEvent: testLauncher, projectRoot: repo },
        ),
        diagnostics.join(" "),
      ).toBe(0)
      const calls = readFileSync(closeCalls, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("\t"))
      expect(calls).toHaveLength(2)
      expect(calls.find(([key]) => key === "issue-first")?.[2]).toBe(failedAction!.providerId)
      expect(readPostMergeIssueDiagnostics(workdir)).toEqual([])
      const retriedListing = await readEventListing(git, config, repo, workdir, deliveredTarget, store, { all: true })
      expect(retriedListing.all.find((row) => row.branch === "task/first")?.diagnostic ?? "").not.toContain(
        "stopped: queue shutdown fixture",
      )
      const originalEvidence = readFileSync(failedPath, "utf8")
      try {
        for (const malformed of [null, { issueActions: "not an array" }, { issueActions: [{ status: "failed" }] }]) {
          writeFileSync(failedPath, JSON.stringify(malformed))
          expect(() => readPostMergeIssueDiagnostics(workdir)).toThrow(failedPath)
          const unread: string[] = []
          expect(
            await coreQueueCommand(
              repo,
              {
                cwd: repo,
                stdout: () => {},
                stderr: (message) => unread.push(message),
                localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
              },
              { command: "list" },
              { workdir, json: true, launchEvent: testLauncher },
            ),
            unread.join(" "),
          ).toBe(0)
          expect(unread.join(" ")).toContain(failedPath)
        }
        // A corrupt derived attempt must not abort the standing read before another real merge.
        await queue("task/after-corrupt", "another delivery\n\nCloses: issue-after-corrupt")
        const unread: string[] = []
        expect(
          await coreQueueCommand(
            repo,
            {
              cwd: repo,
              stdout: () => {},
              stderr: (message) => unread.push(message),
              localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
            },
            { command: "merge", branch: "task/after-corrupt", submitter: "fixture" },
            { workdir, json: true, launchEvent: testLauncher, projectRoot: repo },
          ),
          unread.join(" "),
        ).toBe(0)
        expect((await readStatus(store, "main", "task/after-corrupt")).status).toBe("merged")
        expect(
          Object.values((await readEventQueue(store, "main")).issueEffects).some(
            ({ effect }) => effect.issueKey === "issue-after-corrupt",
          ),
        ).toBe(true)
        expect(unread.join(" ")).toContain(failedPath)
      } finally {
        writeFileSync(failedPath, originalEvidence)
      }
      return
    }
    expect(merged).toContain("task/second")
    expect(merged).toContain("task/refs")
    expect((await readStatus(store, "main", "task/second")).status).toBe("merged")
    expect((await readStatus(store, "main", "task/refs")).status).toBe("merged")
    const attempts = readdirSync(join(workdir, "post-merge"))
      .filter((n) => n.endsWith(".json"))
      .map((n) => attemptAt(join(workdir, "post-merge", n)))
    expect(attempts.length).toBeGreaterThan(0)
    // A round that merged nothing settles as skipped; no attempt fails.
    expect(
      attempts.every((attempt) => attempt.status === "succeeded" || attempt.status === "skipped"),
      JSON.stringify(attempts),
    ).toBe(true)
    expect(attempts.some((attempt) => attempt.status === "succeeded")).toBe(true)
    const calls = readFileSync(closeCalls, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("\t"))
    expect(calls.map(([key, reason]) => [key, reason]).sort()).toEqual(
      [
        [mode === "delivered-declaration" ? "delivered-issue-first" : "issue-first", "completed"],
        ...(mode === "observed-ff" || mode === "observed-after-target" ? [["issue-older", "completed"]] : []),
        ...(mode === "observed-stacked" ? [["issue-stacked", "completed"]] : []),
        ...(mode === "observed-merge" ? [["issue-merge", "completed"]] : []),
        [mode === "delivered-declaration" ? "delivered-issue-second" : "issue-second", "completed"],
      ].sort(),
    )
    const effects = await Promise.all(
      ["task/first", "task/second", "task/refs"].map((branch) => readBranchHistory(store, "main", branch)),
    )
    const byBranch = new Map(
      ["task/first", "task/second", "task/refs"].map((branch, index) => [branch, effects[index]!.history!]),
    )
    const completed = Object.values((await readEventQueue(store, "main")).issueEffects)
    const durable = (branch: string) =>
      completed
        .filter(({ effect }) => effect.mergedEvent === byBranch.get(branch)!.state.ending!.id)
        .map(({ effect }) => effect)
    for (const [branch, key] of [
      ["task/first", "issue-first"],
      ["task/second", "issue-second"],
    ] as const) {
      const history = byBranch.get(branch)!
      const mergeSha = history.state.merge!
      const mergedEvent = history.state.ending!.id
      const committerTime = new Date((await git(["show", "-s", "--format=%cI", mergeSha])).trim()).toISOString()
      expect(durable(branch)).toContainEqual(
        expect.objectContaining({
          mergedEvent,
          mergeSha,
          mergeCommitterTime: committerTime,
          verb: "close",
          semanticEnding: "completed",
          issueKey: mode === "delivered-declaration" ? `delivered-${key}` : key,
        }),
      )
    }
    expect(durable("task/refs")).toEqual([])
    const migratedCalls = join(root, "migrated-close-calls")
    if (mode === "declaration-edit") {
      await git(["fetch", "--quiet", "origin", "main"])
      await git(["merge", "--quiet", "--ff-only", "origin/main"])
      writeFileSync(
        join(repo, "issues.yml"),
        JSON.stringify({
          resolve: ["sh", "-c", 'printf \'{"keys":["different-backend-key"]}\\n\''],
          close: [
            "sh",
            "-c",
            closeScript,
            "close",
            "<key>",
            "<reason>",
            "<id>",
            migratedCalls,
            closeReady,
            closeRelease,
          ],
        }),
      )
      await git(["add", "issues.yml"])
      await git(["commit", "--quiet", "-m", "change provider declaration after fulfilled closes"])
      await git(["push", "--quiet", "origin", "main"])
    }
    if (mode === "cold-replay") {
      const reading = await readBranchHistory(store, "main", "task/first")
      if (store.backend.publish === undefined || reading.history?.state.tip === undefined) {
        throw new Error("fixture lacks cold custody publisher")
      }
      await store.backend.publish(
        store.repo,
        [
          { ref: "refs/yrd-archive/main/task/first", expect: "0".repeat(40), oid: reading.history.state.tip },
          { ref: reading.ref, expect: reading.history.state.tip, oid: null },
        ],
        "origin",
      )
      await seed(["--git-dir", remote, "gc", "--prune=now"])
      await git(["gc", "--prune=now"])
      expect(
        Object.values((await readEventQueue(store, "main")).issueEffects).some(
          ({ effect }) => effect.mergedEvent === reading.history!.state.ending!.id,
        ),
      ).toBe(true)
    }
    // Startup catch-up over real registered worktrees replays unchanged merged history; it must not resend a fulfilled close.
    const environments = join(workdir, "environments")
    mkdirSync(environments, { recursive: true })
    await git(["worktree", "add", "--quiet", join(environments, "first"), "task/first"])
    await git(["worktree", "add", "--quiet", join(environments, "second"), "task/second"])
    await git(["worktree", "add", "--quiet", join(environments, "refs"), "task/refs"])
    const callCount = calls.length
    const replayStop = new AbortController()
    const replayAttemptStart = new Set(readdirSync(join(workdir, "post-merge")))
    expect(
      await coreQueueCommand(
        repo,
        {
          cwd: repo,
          stdout: () => {},
          stderr: (s) => diagnostics.push(s),
          localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
        },
        {
          command: "up",
          intervalSeconds: 0,
          stop: replayStop.signal,
          afterRound: async () => {
            await vi.waitFor(
              () => {
                const attempts = readdirSync(join(workdir, "post-merge"))
                  .filter((name) => name.endsWith(".json") && !replayAttemptStart.has(name))
                  .map(
                    (name) =>
                      JSON.parse(readFileSync(join(workdir, "post-merge", name), "utf8")) as {
                        endedAt?: string
                        merged: string[]
                        issueActions: Array<{ branch: string; status: string }>
                      },
                  )
                expect(attempts.length).toBeGreaterThan(0)
                expect(attempts.every((attempt) => attempt.endedAt !== undefined)).toBe(true)
                const acted = attempts.flatMap((attempt) => attempt.merged)
                expect(acted).toEqual(expect.arrayContaining(["task/first", "task/second", "task/refs"]))
                for (const branch of ["task/first", "task/second"]) {
                  expect(attempts.flatMap((attempt) => attempt.issueActions)).toContainEqual(
                    expect.objectContaining({ branch, status: "fulfilled" }),
                  )
                }
              },
              { timeout: 10000 },
            )
            replayStop.abort()
          },
        },
        { workdir, json: true, launchEvent: testLauncher, projectRoot: repo },
      ),
      diagnostics.join(" "),
    ).toBe(0)
    replayStop.abort()
    expect(existsSync(migratedCalls), "a declaration edit must not migrate fulfilled closes to another backend").toBe(
      false,
    )
    await vi.waitFor(
      () => {
        const currentCalls = readFileSync(closeCalls, "utf8").trim().split("\n").filter(Boolean)
        expect(currentCalls).toHaveLength(callCount)
      },
      { timeout: 5000 },
    )
    if (mode === "blob-mismatch") {
      const reading = await readBranchHistory(store, "main", "task/first")
      const applied = Object.values((await readEventQueue(store, "main")).issueEffects).find(
        ({ effect }) => effect.mergedEvent === reading.history!.state.ending!.id,
      )!.effect
      const wrongBlob = (await git(["rev-parse", `${applied.mergeSha}:.yrd.yml`])).trim()
      expect(wrongBlob).not.toBe(applied.declaration.blob)
      // Preserve a historical branch fact as raw fixture data after retiring the public branch writer.
      const historical = await openEvents({ ...store, ref: reading.ref, writer: "yrd-run" })
      await historical.append(
        [
          changeInput("notified", {
            queueTip: (await readEventQueue(store, "main")).tip,
            at: new Date(),
            commit: applied.mergeSha,
            issueEffect: {
              kind: "issue-effect-v1",
              mergedEvent: applied.mergedEvent,
              mergeSha: applied.mergeSha,
              mergeCommitterTime: applied.mergeCommitterTime,
              verb: "comment",
              issueKey: applied.issueKey,
              providerId:
                "yrd1-" +
                createHash("sha256")
                  .update(JSON.stringify([applied.mergeSha, "comment", null, applied.issueKey]))
                  .digest("hex"),
              declaration: { path: "issues.yml", blob: wrongBlob },
            },
          }),
        ],
        { expect: reading.history!.state.tip! },
      )
      const resolutionsBefore = readFileSync(resolveCalls, "utf8")
      const closesBefore = readFileSync(closeCalls, "utf8")
      await using runner = createPostMerge({
        workdir,
        launchEvent: testLauncher,
        cwd: repo,
        git,
        store,
        cleanup: async () => {},
        report: (message) => diagnostics.push(message),
      })
      runner.nudge({
        ...context,
        target: applied.mergeSha,
        merged: ["task/first"],
        projectRoot: repo,
        queueBranch: "main",
      })
      await runner[Symbol.asyncDispose]()
      expect(diagnostics.join(" ")).toContain(
        `applied declaration blob ${wrongBlob} differs from pinned ${applied.declaration.blob}`,
      )
      expect(readFileSync(resolveCalls, "utf8")).toBe(resolutionsBefore)
      expect(readFileSync(closeCalls, "utf8")).toBe(closesBefore)
    }
  },
  60000,
)

/** Appends a provider call's five operands to its sixth, one line per call. */
const EVENT_WRITE = 'printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$1" "$2" "$3" "$4" "$5" >> "$6"; '
/** `event` declared through a provider that logs each call to `calls`, then answers `reply`. */
const eventDeclared = (calls: string, reply = "printf '{\"applied\":true}\\n'") => ({
  event: ["sh", "-c", EVENT_WRITE + reply, "event", "<raw>", "<kind>", "<source>", "<text>", "<id>", calls],
})

/**
 * A queue on a bare remote whose issues.yml is `issues(calls)` and whose .yrd.yml is `declaration`; every provider
 * call lands in `calls`.
 */
const eventQueue = async (
  issues: (calls: string) => Record<string, unknown>,
  declaration: Record<string, unknown> = {},
) => {
  const root = world(),
    remote = join(root, "remote.git"),
    repo = join(root, "author"),
    workdir = join(root, "queue"),
    calls = join(root, "event-calls.tsv")
  mkdirSync(workdir)
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.email", "provider@yrd.test"])
  await git(["config", "user.name", "fixture"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(repo, ".yrd.yml"), JSON.stringify(declaration))
  writeFileSync(join(repo, "issues.yml"), JSON.stringify(issues(calls)))
  await git(["add", ".yrd.yml", "issues.yml"])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim(),
    config = await readConfig(git, target, { remote: "origin", branch: "main" })
  if (config === undefined) throw Error("fixture queue lost config")
  const store = createEventStore(repo, "origin", git.selection)
  await createEventQueue(store, "main", target, config, new Date())
  return { root, remote, repo, workdir, calls, seed, git, store }
}

/** Submits `branch` at one new commit on the remote's main, naming `issue` when given. */
const submitChange = async (
  queue: Readonly<{ repo: string; git: ReturnType<typeof gitIn> }>,
  branch: string,
  issue: string | undefined,
  label: string,
): Promise<void> => {
  await queue.git(["fetch", "--quiet", "origin"])
  await queue.git(["checkout", "--quiet", "-B", branch, "origin/main"])
  writeFileSync(join(queue.repo, label + ".txt"), label)
  await queue.git(["add", "."])
  await queue.git(["commit", "--quiet", "-m", label])
  await submit(queue.git, "origin", {
    branch,
    submitter: "fixture",
    target: { remote: "origin", branch: "main" },
    ...(issue === undefined ? {} : { issue }),
  })
  await queue.git(["checkout", "--quiet", "main"])
}

/**
 * The launcher every round in this file gets (hh #38766): production launches a detached CLI child, and a unit test
 * injects this so the round's decision is proven without spawning one. The child's own argv has its own test.
 */
const testLauncher: (input: IssueEventLaunchInput) => IssueEventLaunch = (input) => ({
  launched: true,
  log: `${String(input.workdir)}/logs/issue-events/${input.opId}.log`,
})

/** The `event` rows of every finished post-merge attempt under `workdir`. */
const eventActionsIn = (workdir: string): Array<Record<string, unknown>> =>
  readdirSync(join(workdir, "post-merge"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(workdir, "post-merge", name), "utf8")) as Record<string, unknown>)
    .filter((attempt) => attempt.status !== "running")
    .flatMap((attempt) => (attempt.issueActions ?? []) as Array<Record<string, unknown>>)
    .filter((action) => action.verb === "event")

/**
 * @failure A merged change makes the merge round wait for a provider write that costs ~35 s against a healthy km and is
 *   unbounded under a lane hold — a serial queue paying it on every merge (hh #38766, @cto 15f0394a, e72bc1a0). The
 *   round must launch the write and return, and the launched row must say where the child's own evidence lands.
 * @level l2 @consumer Yrd post-merge merged item events, launched (#38766) @testonly none
 */
it("launches one merged item event per delivered change and returns without waiting for it", async () => {
  const queue = await eventQueue((calls) => eventDeclared(calls))
  const launched: Array<{ issue: string; opId: string; text: string; fallback?: { kind: string; text: string } }> = []
  const { merge, diagnostics } = await mergeOnce(queue, (input) => {
    launched.push({
      issue: input.issue,
      opId: input.opId,
      text: input.text,
      ...(input.fallback === undefined ? {} : { fallback: { ...input.fallback } }),
    })
    return { launched: true, log: join(queue.workdir, "logs", "issue-events", `${input.opId}.log`) }
  })
  expect(merge).toBeTruthy()
  // No provider ran in this process: the write left with the child.
  expect(existsSync(queue.calls) ? readFileSync(queue.calls, "utf8").trim() : "").toBe("")
  // One launch per delivered change, named after the branch that merged.
  expect(launched.map((one) => one.text.split(" ")[0])).toEqual([TWICE])
  const row = eventActionsIn(queue.workdir).find((action) => action.status === "launched")
  expect(row, diagnostics.join(" | ")).toMatchObject({
    verb: "event",
    status: "launched",
    issue: "@i/16-work-lifecycle/31194-item-events",
    log: expect.stringContaining("logs/issue-events/yrd-merged-"),
  })
  // The child carries the branch's own failure notify, so a write that does not land never reads as an abandoned branch.
  expect(launched[0]?.fallback).toMatchObject({ kind: "failed" })
  expect(launched[0]?.fallback?.text).toContain("did not land")
}, 60000)

/**
 * @failure The closer writes `launched` rows (hh #38766) and the union, the projection and the writer all accept that
 *   status, but the decoder's status check did not: `yrd queue show <branch> --json` threw "unknown issue action status
 *   launched" on every attempt holding a launched write, so the per-change view went blind while the queue was busy. The
 *   reader must accept what the writer emits, and still refuse a launched row that names no log.
 * @level l2 @consumer Yrd post-merge evidence read back into `yrd queue show` (#38766 launched rows) @testonly none
 */
it("reads the launched status the closer writes, and still refuses a launched row with no log", () => {
  const workdir = world()
  const directory = join(workdir, "post-merge")
  mkdirSync(directory, { recursive: true })
  const identity = {
    branch: "task/launched",
    mergedEvent: "event-1",
    mergeSha: "a".repeat(40),
    providerId: "yrd-merged-a",
  }
  writeFileSync(
    join(directory, "attempt-1.json"),
    JSON.stringify({
      issueActions: [
        { ...identity, verb: "event", status: "launched", log: join(workdir, "logs", "issue-events", "one.log") },
        { ...identity, status: "failed", diagnostic: "provider ended with exit 1" },
      ],
    }),
  )
  // A launched write is not this process's outcome to report: only the failed row stays a diagnostic.
  expect(readPostMergeIssueDiagnostics(workdir)).toEqual([{ ...identity, diagnostic: "provider ended with exit 1" }])
  writeFileSync(
    join(directory, "attempt-2.json"),
    JSON.stringify({ issueActions: [{ ...identity, status: "launched" }] }),
  )
  expect(() => readPostMergeIssueDiagnostics(workdir)).toThrow(/launched issue action lacks log/)
})

/**
 * @failure A .yrd.yml still holding the retired issuesProvider.update has it run on a landing, beside Yrd's own closer
 *   (the old provider closed issues first on every landing), or the retired key is ignored without a word.
 * @level l2 @consumer Yrd's post-merge closer as the only writer closing issues from merge trailers (29630, @cto 5a66fb46)
 * @testonly none
 */
it("never runs a retired issuesProvider.update on a merge, says so on stderr, and closes through issues.yml", async () => {
  const marker = join(world(), "retired-update-ran")
  const fakeProvider = join(import.meta.dirname, "support", "fake-issues-provider.ts")
  const { repo, workdir, calls, git, store } = await eventQueue(
    (calls) => ({
      resolve: [process.execPath, fakeProvider, "resolve", "<raw>"],
      close: [
        "sh",
        "-c",
        'printf "%s\\t%s\\n" "$1" "$2" >> "$4"; printf \'{"applied":true}\\n\'',
        "close",
        "<key>",
        "<reason>",
        "<id>",
        calls,
      ],
    }),
    { issuesProvider: { update: ["sh", "-c", 'touch "$1"', "update", marker] } },
  )
  const branch = "task/retired-update"
  await git(["checkout", "--quiet", "-b", branch, "origin/main"])
  writeFileSync(join(repo, "retired.txt"), "lands under a retired update key")
  await git(["add", "retired.txt"])
  await git(["commit", "--quiet", "-m", "retired update\n\nCloses: issue-retired"])
  await submit(git, "origin", { branch, submitter: "fixture", target: { remote: "origin", branch: "main" } })
  await git(["checkout", "--quiet", "main"])
  const stderr: string[] = []
  expect(
    await coreQueueCommand(
      repo,
      {
        cwd: repo,
        stdout: () => {},
        stderr: (message) => stderr.push(message),
        localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
      },
      { command: "merge", branch, submitter: "fixture" },
      { workdir, json: true, launchEvent: testLauncher, projectRoot: repo },
    ),
    stderr.join(""),
  ).toBe(0)
  expect((await readStatus(store, "main", branch)).status).toBe("merged")
  // Said once for the command, however many times it reads the declaration in force (@cto 19089cc0).
  const cure =
    "yrd: .yrd.yml issuesProvider: retired in #29630 and ignored; delete this key. Yrd's post-merge closer closes issues from merge trailers through issues.yml at --project-root, and the issue display reads issues.yml's view (origin/main)."
  expect(stderr.join("").split(cure).length - 1, stderr.join("")).toBe(1)
  expect(existsSync(marker), "the retired update must never run").toBe(false)
  // Yrd's own closer closed the trailer's issue, once.
  expect(existsSync(calls), stderr.join("")).toBe(true)
  expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["issue-retired\tcompleted"])
}, 60000)

const ISSUE_31194 = "@i/16-work-lifecycle/31194-item-events"
const TWICE = "task/twice"
/** The IO a CLI-path round is given: every line it prints lands in `diagnostics`. */
const fixtureIo = (repo: string, diagnostics: string[]) => ({
  cwd: repo,
  stdout: (s: string) => diagnostics.push(s),
  stderr: (s: string) => diagnostics.push(s),
  localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
})

/**
 * Merges TWICE once through the CLI path production uses, and names what the round said: the merge it delivered, the
 * base it judged against, and every line it printed.
 */
const mergeOnce = async (
  queue: Awaited<ReturnType<typeof eventQueue>>,
  launchEvent?: (input: IssueEventLaunchInput) => IssueEventLaunch,
): Promise<Readonly<{ merge: string; base: string; diagnostics: string[] }>> => {
  await submitChange(queue, TWICE, ISSUE_31194, "first")
  const stop = new AbortController(),
    diagnostics: string[] = []
  let rounds = 0,
    merge = "",
    base = ""
  try {
    expect(
      await coreQueueCommand(
        queue.repo,
        fixtureIo(queue.repo, diagnostics),
        {
          command: "up",
          intervalSeconds: 0,
          stop: stop.signal,
          afterRound: async (outcome) => {
            rounds++
            if (outcome.merged.includes(TWICE)) {
              merge = (await readStatus(queue.store, "main", TWICE)).merge!
              base = outcome.base
              stop.abort()
            } else if (rounds > 12) stop.abort()
          },
        },
        { workdir: queue.workdir, json: true, ...(launchEvent === undefined ? {} : { launchEvent }) },
      ),
      diagnostics.join(" "),
    ).toBe(0)
  } finally {
    stop.abort()
  }
  return { merge, base, diagnostics }
}

/**
 * Runs `up` until TWICE has merged twice, each merge's own attempt ending before the next submit, so the two rounds
 * never share one attempt; returns each merge and the base its round was judged against.
 */
/**
 * @failure A failed post-merge issue update is dropped: later attempts carry only their own merge, so the failed
 *   branch's issue stays open with its code on main until the next service restart's catch-up (77 min, 37513).
 * @level l2 @consumer Yrd post-merge issue close carry-forward (37513, @cto 68bee3e1) @testonly none
 */
it("carries a failed attempt's branches into the next attempt, and names them after the third failure", async () => {
  const root = world()
  const reports: string[] = []
  const abandoned: Array<Readonly<{ branch: string; attempts: number; reason: string; evidence: string }>> = []
  // Yrd's closer fails the attempt when an explicit projectRoot lacks the queue's inputs; no projectRoot settles it.
  const fail = { projectRoot: root }
  const pass = {}
  await using runner = createPostMerge({
    workdir: root,
    launchEvent: testLauncher,
    cwd: root,
    cleanup: async () => {},
    report: (message) => reports.push(message),
    abandoned: async (_context, given) => {
      abandoned.push(...given)
    },
  })
  const attempts = () =>
    readdirSync(join(root, "post-merge"))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(
        (name) =>
          JSON.parse(readFileSync(join(root, "post-merge", name), "utf8")) as Attempt & {
            merged: string[]
            bases: string[]
          },
      )
  const settledCount = async (count: number) =>
    vi.waitFor(() => expect(attempts().filter((a) => a.status !== "running")).toHaveLength(count), { timeout: 10000 })

  // Attempt 1 fails; attempt 2 is a later round's own merge and carries the failed branch with it.
  runner.nudge({ ...context, target: "r1", base: "b1", merged: ["task/one"], ...fail })
  await settledCount(1)
  runner.nudge({ ...context, target: "r2", base: "b2", merged: ["task/two"], ...fail })
  await settledCount(2)
  expect(attempts()[1]).toMatchObject({ merged: ["task/one", "task/two"], bases: ["b1", "b2"] })
  // An idle round still carries what failed, though the round itself merged nothing.
  runner.nudge({ ...context, target: "r3", base: "b3", merged: [], ...fail })
  await settledCount(3)
  expect(attempts()[2]).toMatchObject({ merged: ["task/one", "task/two"], status: "unavailable" })
  // task/one failed three times: named and handed on, never carried again. task/two has failed twice.
  await vi.waitFor(() => expect(abandoned.map((a) => a.branch)).toEqual(["task/one"]), { timeout: 10000 })
  expect(abandoned[0]).toMatchObject({ attempts: 3, evidence: expect.stringMatching(/post-merge\/.*\.json$/) })
  expect(abandoned[0]!.reason).toContain("automatic issue close unavailable")
  expect(reports.some((line) => line.includes("task/one") && line.includes("3 attempts"))).toBe(true)
  runner.nudge({ ...context, target: "r4", base: "b4", merged: ["task/three"], ...pass })
  await settledCount(4)
  // task/one's round base left with it: a carried branch keeps only its own round's base (@dev/4).
  expect(attempts()[3]).toMatchObject({ merged: ["task/two", "task/three"], bases: ["b2", "b4"], status: "succeeded" })
  // A success settles what it carried: the next attempt carries nothing old.
  runner.nudge({ ...context, target: "r5", base: "b5", merged: ["task/four"], ...pass })
  await settledCount(5)
  expect(attempts()[4]).toMatchObject({ merged: ["task/four"], bases: ["b5"] })
  expect(abandoned.map((a) => a.branch)).toEqual(["task/one"])
})

/**
 * @failure A branch still owed merges again while the provider is down. Its carry then keeps only the re-merge's
 *   base, the earlier delivery's merge is an ancestor of that base, and its merged event is skipped for good (37513,
 *   @dev/4 GO 546f9f23). A fresh merge also starts the branch's failure count over.
 * @level l2 @consumer Yrd post-merge carry-forward bases (37513) @testonly none
 */
it("keeps a still-owed branch's earlier round base when it merges again, and starts its count over", async () => {
  const root = world()
  const abandoned: string[] = []
  // Yrd's closer fails the attempt when an explicit projectRoot lacks the queue's inputs.
  const fail = { projectRoot: root }
  await using runner = createPostMerge({
    workdir: root,
    launchEvent: testLauncher,
    cwd: root,
    cleanup: async () => {},
    report: () => {},
    abandoned: async (_context, given) => {
      abandoned.push(...given.map(({ branch }) => branch))
    },
  })
  const attempts = () =>
    readdirSync(join(root, "post-merge"))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(root, "post-merge", name), "utf8")) as Attempt & { bases: string[] })
  const settledCount = async (count: number) =>
    vi.waitFor(() => expect(attempts().filter((a) => a.status !== "running")).toHaveLength(count), { timeout: 10000 })

  runner.nudge({ ...context, target: "r1", base: "b1", merged: ["task/one"], ...fail })
  await settledCount(1)
  // task/one merges again while its first delivery is still owed.
  runner.nudge({ ...context, target: "r2", base: "b2", merged: ["task/one"], ...fail })
  await settledCount(2)
  runner.nudge({ ...context, target: "r3", base: "b3", merged: [], ...fail })
  await settledCount(3)
  // The carry still holds b1, which precedes both deliveries.
  expect(attempts()[2]).toMatchObject({ merged: ["task/one"], bases: ["b1", "b3"], status: "unavailable" })
  // Three failed attempts, but the re-merge started the count over: two since it, so not yet given up.
  expect(abandoned).toEqual([])
})

/** @failure One branch's failed close charges every branch in the attempt, so a settled branch is retried and can be
 *   given up on for another's fault; or a failure that names no branch carries none (37513, @dev/4). @level l1
 *   @consumer Yrd post-merge carry-forward attribution @testonly none */
it("charges a failed attempt to the branch its failure names, and to every branch when it names none", () => {
  const merged = ["task/real", "task/ghost"]
  const closeFailed = [
    { branch: "task/real", status: "failed" },
    { branch: "task/ghost", status: "fulfilled" },
  ]
  expect(chargedBranches(merged, closeFailed, false)).toEqual(["task/real"])
  // The attempt itself failed too: that names nobody, so both branches are charged.
  expect(chargedBranches(merged, closeFailed, true)).toEqual(merged)
  // A failed attempt whose rows name no branch of its own still charges every branch it carried.
  expect(chargedBranches(merged, [{ branch: "task/elsewhere", status: "failed" }], false)).toEqual(merged)
  expect(chargedBranches(merged, [], false)).toEqual(merged)
})

/** @failure A status listing opened every post-merge attempt ever written — 38 MB on a queue holding 13,917 (#38870).
 * @level l2 @consumer yrd ls read cost
 */
it("reads only post-merge attempts opened inside the listing's horizon, and never skips on an unreadable name", () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-38870-post-merge-"))
  roots.push(root)
  mkdirSync(join(root, "post-merge"))
  const attempt = (diagnostic: string, providerId: string) =>
    JSON.stringify({
      issueActions: [
        {
          status: "failed",
          branch: "task/one",
          mergedEvent: "m1",
          mergeSha: "a".repeat(40),
          providerId,
          diagnostic,
        },
      ],
    })
  writeFileSync(join(root, "post-merge", "2026-10-24T08-57-45.354Z-old.json"), attempt("old failure", "p1"))
  writeFileSync(join(root, "post-merge", "2026-11-26T22-00-00.000Z-new.json"), JSON.stringify({ issueActions: [] }))
  writeFileSync(join(root, "post-merge", "hand-made.json"), attempt("unreadable name kept", "p2"))
  const notBefore = new Date("2026-11-26T00:00:00.000Z")
  expect(readPostMergeIssueDiagnostics(root, undefined, { notBefore }).map((row) => row.diagnostic)).toEqual([
    "unreadable name kept",
  ])
  expect(readPostMergeIssueDiagnostics(root).map((row) => row.diagnostic)).toEqual([
    "old failure",
    "unreadable name kept",
  ])
})
