/**
 * @reach fs-walk <fixture-only: temporary provider and result directories>
 * @failure A blocked or failed provider holds the merge line or skips Git cleanup; restart replays stored results.
 * @level l2
 * @consumer Yrd post-merge provider and cleanup lifecycle
 * @testonly none
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createPostMerge } from "../src/post-merge.ts"
import { readIssueDisplay } from "../src/issue-resolver.ts"
import { coreQueueCommand } from "../src/queue-core-commands.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { createEventQueue, createEventStore, readConfig, readStatus, submit } from "@yrd/queue-core"
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
it("substitutes an opaque display key and names malformed or failed reads unavailable", async () => {
  const root = world()
  const key = "-/different/vault/@x/key.md"
  expect(await readIssueDisplay(["sh", "-c", `printf '{"key":"%s"}' "$1"`, "display", "<key>"], key, root)).toEqual({
    available: true,
    data: { key },
  })
  expect(await readIssueDisplay(["sh", "-c", "printf nope"], key, root)).toMatchObject({
    available: false,
    reason: expect.stringContaining("invalid JSON"),
  })
  expect(await readIssueDisplay(["sh", "-c", "exit 9"], key, root)).toMatchObject({
    available: false,
    reason: expect.stringContaining("exit 9"),
  })
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

it("merges a second submitted change while the startup provider remains blocked, then reaps it on stop", async () => {
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
    finished = join(root, "finished")
  await git(["config", "user.email", "provider@yrd.test"])
  await git(["config", "user.name", "fixture"])
  await git(["checkout", "--quiet", "-b", "main"])
  const script =
    'printf "%s" "$$" > "$1"; turns=0; while test "$turns" -lt 400; do turns=$((turns+1)); sleep .1; done; touch "$2"'
  writeFileSync(
    join(repo, ".yrd.yml"),
    JSON.stringify({ issuesProvider: { update: ["sh", "-c", script, "provider", ready, finished] } }),
  )
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim(),
    config = await readConfig(git, target, { remote: "origin", branch: "main" })
  if (config === undefined) throw Error("fixture queue lost config")
  const store = createEventStore(repo, "origin", git.selection)
  await createEventQueue(store, "main", target, config, new Date())
  const queue = async (branch: string) => {
    await git(["checkout", "--quiet", "-b", branch, "origin/main"])
    writeFileSync(join(repo, branch.replaceAll("/", "-") + ".txt"), branch)
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", branch])
    const submitted = await submit(git, "origin", {
      branch,
      submitter: "fixture",
      target: { remote: "origin", branch: "main" },
    })
    await git(["checkout", "--quiet", "main"])
    return submitted
  }
  await queue("task/first")
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
          stdout: () => {},
          stderr: (s) => diagnostics.push(s),
          localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
        },
        {
          command: "up",
          intervalSeconds: 0,
          stop: stop.signal,
          terminate: {
            on: (handler) => {
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
          afterRound: async (outcome) => {
            rounds++
            merged.push(...outcome.merged)
            await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10000 })
            expect(existsSync(finished)).toBe(false)
            if (merged.includes("task/first") && !merged.includes("task/second")) await queue("task/second")
            if (merged.includes("task/second")) terminate?.("SIGTERM")
            else if (rounds > 3) stop.abort()
          },
        },
        { workdir, json: true },
      ),
      diagnostics.join(" "),
    ).toBe(0)
  } finally {
    stop.abort()
  }
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
}, 60000)
