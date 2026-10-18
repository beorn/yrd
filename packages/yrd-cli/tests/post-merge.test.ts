/**
 * @reach fs-walk <fixture-only: temporary provider and result directories>
 * @failure A blocked or failed provider holds the merge line or skips Git cleanup; restart replays stored results.
 * @level l2
 * @consumer Yrd post-merge provider and cleanup lifecycle
 * @testonly none
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createPostMerge, readPostMergeIssueDiagnostics } from "../src/post-merge.ts"
import { coreQueueCommand, readEventListing } from "../src/queue-core-commands.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { Conflict, openEvents } from "../../yrd-queue-core/src/git.ts"
import { changeInput } from "../../yrd-queue-core/src/events.ts"
import {
  createEventQueue,
  changesRef,
  appendChangeEvent,
  createEventStore,
  readBranchHistory,
  readEventQueue,
  queueRef,
  readConfig,
  readStatus,
  submit,
  trailer,
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
/** @failure Stop silently drops coalesced merged branch names, so branch triage cannot recover pending cleanup. @level l2 @consumer Yrd service handoff @testonly none */
it.each([
  { removed: false, ending: "drain" },
  { removed: true, ending: "drain" },
  { removed: false, ending: "stop" },
  { removed: false, ending: "close" },
] as const)(
  "coalesces catch-up and honors current provider configuration (removed=$removed, ending=$ending)",
  async ({ removed, ending }) => {
    const root = world()
    const ready = join(root, "ready")
    const release = join(root, "release")
    const argv = [
      "sh",
      "-c",
      'touch "$1"; while ! test -f "$2"; do sleep .05; done; echo failure >&2; exit 7',
      "provider",
      ready,
      release,
    ]
    const cleaned: string[] = []
    const completed: string[] = []
    const errors: string[] = []
    const stop = new AbortController()
    await using runner = createPostMerge({
      workdir: root,
      cwd: root,
      ...(ending === "drain" ? {} : { stop: stop.signal }),
      cleanup: async (c) => {
        cleaned.push(c.target)
        await Promise.resolve()
        if (ending === "stop") stop.abort()
        completed.push(c.target)
      },
      report: (s) => errors.push(s),
    })
    runner.nudge({ ...context, update: argv })
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10000 })
    runner.nudge({ ...context, target: "second", merged: ["task/two"], update: ["sh", "-c", "printf caught-up"] })
    runner.nudge({
      ...context,
      target: "third",
      merged: ["task/three", "task/two"],
      update: removed ? undefined : ["sh", "-c", "printf caught-up"],
      updateDue: false,
    })
    expect(cleaned).toEqual([])
    if (ending !== "close") writeFileSync(release, "go")
    if (ending === "stop") {
      await vi.waitFor(() => expect(completed).toEqual(["merge-oid"]), { timeout: 10000 })
      // Observe pump's stop reporting before invoking close, which has its own
      // pending-context drop path. Both must report one coalesced set of names.
      await vi.waitFor(
        () => expect(errors.filter((line) => line.includes("task/two") || line.includes("task/three"))).toHaveLength(1),
        { timeout: 1500 },
      )
    }
    await runner[Symbol.asyncDispose]()
    if (ending !== "drain") {
      expect(cleaned, "pending cleanup does not run after handoff").toEqual(["merge-oid"])
      expect(completed, "active cleanup finishes before disposal returns").toEqual(["merge-oid"])
      const dropped = errors.filter((line) => line.includes("task/two") || line.includes("task/three"))
      expect(dropped, "one report identifies the coalesced pending branches").toHaveLength(1)
      expect(dropped[0]).toContain("task/two")
      expect(dropped[0]).toContain("task/three")
      return
    }
    expect(cleaned).toEqual(["merge-oid", "third"])
    const results = readdirSync(join(root, "post-merge"))
      .filter((n) => n.endsWith(".json"))
      .map((n) => attemptAt(join(root, "post-merge", n)))
      .sort((a, b) => (a.target === "merge-oid" ? -1 : b.target === "merge-oid" ? 1 : 0))
    expect(results.map((r) => r.exitCode)).toEqual([7, removed ? undefined : 0])
    expect(results[0]).toMatchObject({
      code: "code-oid",
      config: "config-oid",
      queue: "origin#main",
      target: "merge-oid",
      argv,
      cwd: root,
      status: "failed",
      timedOut: false,
      signal: null,
    })
    expect(readFileSync(results[0]!.stderr, "utf8")).toContain("failure")
    expect(readFileSync(results[1]!.stdout, "utf8")).toBe(removed ? "" : "caught-up")
    expect(errors.join(" ")).toContain("exit 7")
  },
)
it("labels interrupted evidence and starts a fresh catch-up without consulting old output", async () => {
  const root = world()
  const cleaned: string[] = []
  {
    await using runner = createPostMerge({
      workdir: root,
      cwd: root,
      cleanup: async (c) => {
        cleaned.push(c.target)
      },
      report: () => {},
    })
    runner.nudge({ ...context, update: ["sh", "-c", "true"] })
    await runner[Symbol.asyncDispose]()
  }
  const path = join(root, "post-merge", readdirSync(join(root, "post-merge")).find((n) => n.endsWith(".json"))!)
  const old = attemptAt(path)
  writeFileSync(path, JSON.stringify({ ...old, status: "running", endedAt: undefined }))
  await using restarted = createPostMerge({
    workdir: root,
    cwd: root,
    cleanup: async (c) => {
      cleaned.push(c.target)
    },
    report: () => {},
  })
  restarted.recover()
  restarted.nudge({ ...context, target: "startup", update: ["sh", "-c", "true"] })
  await restarted[Symbol.asyncDispose]()
  expect(attemptAt(path).status).toBe("interrupted")
  expect(cleaned).toEqual(["merge-oid", "startup"])
})
it("attempts the provider and cleanup even when its derived artifact directory is unwritable", async () => {
  const root = world(),
    marker = join(root, "provider-ran")
  writeFileSync(join(root, "post-merge"), "occupied by a file")
  const cleaned: string[] = [],
    reports: string[] = []
  await using runner = createPostMerge({
    workdir: root,
    cwd: root,
    cleanup: async (c) => {
      cleaned.push(c.target)
    },
    report: (s) => reports.push(s),
  })
  runner.nudge({ ...context, update: ["sh", "-c", 'touch "$1"', "provider", marker] })
  await runner[Symbol.asyncDispose]()
  expect(existsSync(marker)).toBe(true)
  expect(cleaned).toEqual(["merge-oid"])
  expect(reports.join(" ")).toContain("post-merge evidence unavailable")
})

it.each([
  { mode: "stop" },
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
  { mode: "blob-mismatch" },
  { mode: "observed-ff" },
  { mode: "observed-after-target" },
  { mode: "observed-stacked" },
  { mode: "observed-stacked-merge" },
  { mode: "observed-merge" },
  { mode: "observed-legacy" },
  { mode: "provider-lost-reply" },
] as const)(
  "preserves the real merge queue while exercising post-merge $mode behavior",
  async ({ mode }) => {
    const reconcileAfterQueue =
      mode.startsWith("append-") ||
      mode === "reuse-pending" ||
      mode === "concurrent" ||
      mode === "provider-lost-reply" ||
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
      ready = join(root, "ready"),
      release = join(root, "release"),
      finished = join(root, "finished"),
      closeCalls = join(root, "close-calls.jsonl"),
      closeReady = join(root, "close-ready"),
      closeRelease = join(root, "close-release"),
      resolveCalls = join(root, "resolve-calls")
    await git(["config", "user.email", "provider@yrd.test"])
    await git(["config", "user.name", "fixture"])
    await git(["checkout", "--quiet", "-b", "main"])
    const script =
      mode === "stop"
        ? 'printf "%s" "$$" > "$1"; turns=0; while test "$turns" -lt 400; do turns=$((turns+1)); sleep .1; done; touch "$2"'
        : 'printf "%s" "$$" > "$1"; while ! test -f "$2"; do sleep .05; done; touch "$3"'
    const fakeProvider = join(import.meta.dirname, "support", "fake-issues-provider.ts")
    const closeScript =
      (mode === "close-stop" ? 'printf "%s" "$$" > "$5"; while ! test -f "$6"; do sleep .05; done; ' : "") +
      'printf "%s\\t%s\\t%s\\n" "$1" "$2" "$3" >> "$4"; ' +
      (mode === "concurrent" ? 'while ! test -f "$6"; do sleep .05; done; ' : "") +
      (mode === "provider-lost-reply"
        ? 'if ! test -f "$5"; then touch "$5"; exit 7; fi; printf \'{"noChange":true}\\n\''
        : "printf '{\"applied\":true}\\n'")
    writeFileSync(
      join(repo, ".yrd.yml"),
      JSON.stringify({
        issuesProvider: {
          update:
            mode === "stop"
              ? ["sh", "-c", script, "provider", ready, finished]
              : ["sh", "-c", script, "provider", ready, release, finished],
        },
      }),
    )
    writeFileSync(
      join(repo, "issues.yml"),
      JSON.stringify({
        resolve:
          mode === "blob-mismatch" || mode === "observed-legacy"
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
    await git(["add", ".yrd.yml", "issues.yml"])
    await git(["commit", "--quiet", "-m", "queue"])
    await git(["push", "--quiet", "origin", "main"])
    const target = (await git(["rev-parse", "HEAD"])).trim(),
      config = await readConfig(git, target, { remote: "origin", branch: "main" })
    if (config === undefined) throw Error("fixture queue lost config")
    const store = createEventStore(repo, "origin", git.selection)
    const queueTip = await createEventQueue(store, "main", target, config, new Date())
    const queue = async (branch: string, message: string) => {
      await git(["checkout", "--quiet", "-b", branch, "origin/main"])
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
      if (mode === "observed-legacy" && branch === "task/first") {
        const head = (await git(["rev-parse", "HEAD"])).trim()
        await git(["push", "--quiet", "origin", branch])
        // A real pre-Base record, rather than a current submit with its field hidden.
        await (
          await openEvents({ ...store, ref: changesRef("main", branch) })
        ).append([changeInput("opened", { queueTip, at: new Date(), commit: head, by: "fixture" })], { expect: null })
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
      await submit(git, "origin", {
        branch: "task/aa-stacked",
        submitter: "fixture",
        target: { remote: "origin", branch: "main" },
      })
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
    } else if (mode.startsWith("observed-")) {
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
    let rounds = 0
    let terminate: ((signal?: NodeJS.Signals) => void) | undefined
    let aliveAtReraise: boolean | undefined
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
            ...(mode === "stop"
              ? {
                  terminate: {
                    on: (handler: (signal?: NodeJS.Signals) => void) => {
                      terminate = handler
                      return () => {
                        terminate = undefined
                      }
                    },
                    reraise: () => {
                      const pid = Number(readFileSync(ready, "utf8"))
                      try {
                        process.kill(pid, 0)
                        aliveAtReraise = true
                      } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
                        aliveAtReraise = false
                      }
                      stop.abort()
                    },
                  },
                }
              : {}),
            afterRound: async (outcome) => {
              rounds++
              merged.push(...outcome.merged)
              if (mode.startsWith("observed-") && merged.includes("task/first")) {
                expect((await readStatus(store, "main", "task/first")).merge).toBe(firstObservedMerge)
              }
              await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10000 })
              expect(existsSync(finished)).toBe(false)
              if (mode === "stop") {
                if (merged.includes("task/first") && !merged.includes("task/second")) {
                  await queue("task/second", "second")
                }
                if (merged.includes("task/second")) terminate?.("SIGTERM")
                else if (rounds > 3) stop.abort()
                return
              }
              if (merged.includes("task/first") && !merged.includes("task/second")) {
                await queue("task/second", "second\n\nCloses: issue-second")
              }
              if (merged.includes("task/second") && !merged.includes("task/refs")) {
                await queue(
                  "task/refs",
                  "mentions only\n\nFixes everything\n\nCloses issue-colonless\n\nRefs: issue-refs",
                )
              }
              if (merged.includes("task/refs")) {
                writeFileSync(release, "go")
                if (reconcileAfterQueue) {
                  await vi.waitFor(() => expect(existsSync(finished)).toBe(true), { timeout: 10000 })
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
                await vi.waitFor(() => expect(existsSync(finished)).toBe(true), { timeout: 5000 })
                stop.abort()
              } else if (rounds > 3) stop.abort()
            },
          },
          {
            workdir,
            json: true,
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
      expect(trailer(before.events.find((event) => event.type === "opened")!, "Base")).toBeUndefined()
      expect(trailer(before.events.find((event) => event.type === "merged")!, "Base")).toBeUndefined()
      await using runner = createPostMerge({
        workdir,
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
    if (mode === "stop") {
      expect(merged).toContain("task/second")
      expect(aliveAtReraise).toBe(false)
      expect((await readStatus(store, "main", "task/second")).status).toBe("merged")
      const attempts = readdirSync(join(workdir, "post-merge"))
        .filter((n) => n.endsWith(".json"))
        .map((n) => attemptAt(join(workdir, "post-merge", n)))
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ status: "failed", timedOut: false })
      expect(attempts[0]!.signal).not.toBeNull()
      expect(existsSync(finished)).toBe(false)
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
    if (mode === "reuse-pending") {
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
      await using runner = createPostMerge({
        workdir,
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
        cwd: repo,
        git,
        store,
        cleanup: async () => {},
        report: (message) => diagnostics.push(message),
      })
      await using second = createPostMerge({
        workdir,
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
      expect(effects[0]!.providerId).toBe(calls[0]![2])
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
          { workdir, json: true, projectRoot: repo },
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
        }
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
    expect(
      attempts.every((attempt) => attempt.status === "succeeded"),
      JSON.stringify(attempts),
    ).toBe(true)
    expect(existsSync(finished)).toBe(true)
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
        { workdir, json: true, projectRoot: repo },
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
      await appendChangeEvent(store, "main", "task/first", reading.history!.state.tip!, {
        type: "notified",
        at: new Date(),
        commit: applied.mergeSha,
        writer: "yrd-run",
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
      })
      const resolutionsBefore = readFileSync(resolveCalls, "utf8")
      const closesBefore = readFileSync(closeCalls, "utf8")
      await using runner = createPostMerge({
        workdir,
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
