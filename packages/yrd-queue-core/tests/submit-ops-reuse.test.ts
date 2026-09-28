/**
 * @failure Submit rereads the unchanged queue chain before publication, spending remote calls without
 *          improving the atomic leases (25626).
 * @level   l1 (real bare remote and Git trace2 processes)
 * @consumer yrd submit's admission and publication path
 * @testonly none
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  appendChangeEvent,
  changeInput,
  changesRef,
  createEventQueue,
  createEventStore,
  gitIn,
  queueRef,
  readConfig,
  readEventQueue,
  selectionFor,
  submit,
  writeQueueEvent,
  type Git,
} from "../src/index.ts"
import { openEvents } from "../src/git.ts"
import { readEventChain } from "../src/event-read.ts"
import { pauseRef } from "../src/refs.ts"
import { traceRemoteCalls } from "../src/remote-calls.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

type World = {
  root: string
  work: string
  remote: string
  git: ReturnType<typeof gitIn>
  fence: string
  target: string
  created: string
}
async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-submit-ops-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "base"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error(`fixture target ${target} lost .yrd.yml`)
  const created = await createEventQueue(
    createEventStore(work, "origin", selectionFor(git)),
    "main",
    target,
    config,
    new Date(),
  )
  const tree = (await git(["rev-parse", `${target}^{tree}`])).trim()
  const fence = (
    await git([
      "commit-tree",
      tree,
      "-p",
      target,
      "-m",
      `moved to event format at ${created}\n\nRecord: paused\nPaused-By: yrd-ops-cutover\nPaused-At: 2026-09-27T00:40:59.853Z\nCause: maintenance\n`,
    ])
  ).trim()
  await git(["checkout", "--quiet", "-b", "task/probe", "main"])
  await git(["commit", "--quiet", "--allow-empty", "-m", "work"])
  await git(["checkout", "--quiet", "main"])
  return { root, work, remote, git, fence, target, created }
}

const request = {
  branch: "task/probe",
  target: { branch: "main", remote: "origin" },
  submitter: "@dev/11",
}

/** A real runner with one mutation between admission and the submit-event prefix listing. */
function beforePublication(w: World, mutate: () => Promise<void>): Git {
  let done = false
  const git: Git = async (args, input) => {
    if (!done && args[0] === "diff-tree") {
      done = true
      await mutate()
    }
    return w.git(args, input)
  }
  return Object.assign(git, { selection: selectionFor(w.git) })
}

async function moveM2(w: World): Promise<string> {
  const tree = (await w.git(["rev-parse", `${w.target}^{tree}`])).trim()
  const next = (
    await w.git([
      "commit-tree",
      tree,
      "-p",
      w.fence,
      "-m",
      `moved to event format at ${w.created}\n\nRecord: paused\nPaused-By: yrd-ops-cutover\nPaused-At: 2026-09-27T00:41:00.000Z\nCause: maintenance\n`,
    ])
  ).trim()
  await w.git(["push", "--quiet", "origin", `${next}:${pauseRef("main")}`])
  return next
}

async function noPublication(w: World): Promise<void> {
  expect((await w.git(["ls-remote", "origin", "refs/heads/task/probe"])).trim()).toBe("")
  expect((await w.git(["ls-remote", "origin", changesRef("main", "task/probe")])).trim()).toBe("")
}

describe("submit reuses a fenced admission observation", () => {
  it("saves the repeated chain read on an unchanged event queue", async () => {
    const w = await world()
    const trace = traceRemoteCalls(join(w.root, "trace"), { seams: true })
    let calls: ReturnType<typeof trace.end>
    try {
      const result = await submit(w.git, "origin", request)
      expect(result.retry).toBe(false)
    } finally {
      calls = trace.end()
    }
    expect(calls.seams.submitEvent).toMatchObject({ "ls-remote": 3, push: 1 })
    expect(calls.seams.submitEvent?.fetch ?? 0).toBe(0)
    expect(calls.seams.unattributed).toBeUndefined()
  })

  it("bounds one-push reads when only the queue tip advances after admission", async () => {
    const w = await world()
    const store = createEventStore(w.work, "origin", selectionFor(w.git))
    const trace = traceRemoteCalls(join(w.root, "trace-moved-queue"), { seams: true })
    let calls: ReturnType<typeof trace.end>
    try {
      const result = await submit(
        beforePublication(w, async () => {
          await writeQueueEvent(store, "main", {
            type: "observed",
            commit: w.target,
            by: "yrd-run",
            at: new Date(),
          })
        }),
        "origin",
        request,
      )
      expect(result.retry).toBe(false)
      expect(result.stop).toBeUndefined()
    } finally {
      calls = trace.end()
    }
    const publication = calls.seams.submitEvent
    const remoteCalls = (publication?.["ls-remote"] ?? 0) + (publication?.fetch ?? 0) + (publication?.push ?? 0)
    expect(publication?.push).toBe(1)
    expect(remoteCalls, JSON.stringify(publication)).toBeLessThanOrEqual(8)
    expect(calls.unreadable).toBe(0)
  })

  it("bounds one-push reads when a stale stuck pause arrives after admission", async () => {
    const w = await world()
    const store = createEventStore(w.work, "origin", selectionFor(w.git))
    const tip = (await readEventQueue(store, "main")).tip
    const opened = await (
      await openEvents({ ...store, ref: changesRef("main", "task/stuck"), writer: "@dev/11" })
    ).append([changeInput("opened", { queueTip: tip, at: new Date(), commit: w.target, by: "@dev/11" })], {
      expect: null,
    })
    if (opened.head === null) throw new Error("fixture stuck change has no opened event tip")
    const stuck = await appendChangeEvent(store, "main", "task/stuck", opened.head, {
      type: "stuck",
      at: new Date(),
      reason: "fixture needs repair",
    })
    await appendChangeEvent(store, "main", "task/stuck", stuck, {
      type: "cancelled",
      at: new Date(),
      reason: "withdrawn",
    })
    const trace = traceRemoteCalls(join(w.root, "trace-stale-stuck"), { seams: true })
    let calls: ReturnType<typeof trace.end>
    try {
      const result = await submit(
        beforePublication(w, async () => {
          await writeQueueEvent(store, "main", {
            type: "paused",
            cause: "stuck",
            by: "@chief",
            reason: "repair task/stuck",
            at: new Date(),
            change: { branch: "task/stuck", head: w.target, event: stuck },
          })
        }),
        "origin",
        request,
      )
      expect(result.retry).toBe(false)
      expect(result.stop).toBeUndefined()
    } finally {
      calls = trace.end()
    }
    const publication = calls.seams.submitEvent
    const remoteCalls = (publication?.["ls-remote"] ?? 0) + (publication?.fetch ?? 0) + (publication?.push ?? 0)
    expect(publication?.push).toBe(1)
    expect(remoteCalls, JSON.stringify(publication)).toBeLessThanOrEqual(8)
    expect(calls.unreadable).toBe(0)
  })

  it("rereads and refuses a retired pause ref appearing before publication", async () => {
    const w = await world()
    await expect(
      submit(
        beforePublication(w, async () => {
          await moveM2(w)
        }),
        "origin",
        request,
      ),
    ).rejects.toThrow(/retired legacy pause ref/u)
    await noPublication(w)
  })

  /** @failure A stale legacy ref blocks submit after M6 although only the runner judges it. */
  it("admits submit without an override-ref read when a stale ref appears before publication (26235)", async () => {
    const w = await world()
    const legacyRef = "refs/yrd/main/override"
    const trace = traceRemoteCalls(join(w.root, "trace-legacy-ref"), { seams: true })
    let calls: ReturnType<typeof trace.end>
    try {
      const result = await submit(
        beforePublication(w, async () => {
          await w.git(["push", "--quiet", "origin", `${w.target}:${legacyRef}`])
        }),
        "origin",
        request,
      )
      expect(result.retry).toBe(false)
    } finally {
      calls = trace.end()
    }
    expect(calls.seams.submitEvent).toMatchObject({ "ls-remote": 3, push: 1 })
    expect(calls.unreadable).toBe(0)
    expect((await w.git(["ls-remote", "origin", changesRef("main", "task/probe")])).trim()).not.toBe("")
  })

  it("rereads and refuses maintenance appearing before publication", async () => {
    const w = await world()
    await expect(
      submit(
        beforePublication(w, async () => {
          await writeQueueEvent(createEventStore(w.work, "origin", selectionFor(w.git)), "main", {
            type: "paused",
            by: "@chief",
            cause: "maintenance",
            reason: "intake migration",
            at: new Date(),
          })
        }),
        "origin",
        request,
      ),
    ).rejects.toThrow(/submission stopped for maintenance/u)
    await noPublication(w)
  })

  it("rederives an admitted stuck stop rather than reusing its change-chain projection", async () => {
    const w = await world()
    const store = createEventStore(w.work, "origin", selectionFor(w.git))
    const tip = (await readEventQueue(store, "main")).tip
    const opened = await (
      await openEvents({ ...store, ref: changesRef("main", "task/stuck"), writer: "@dev/11" })
    ).append([changeInput("opened", { queueTip: tip, at: new Date(), commit: w.target, by: "@dev/11" })], {
      expect: null,
    })
    if (opened.head === null) throw new Error("fixture stuck change has no opened event tip")
    const stuck = await appendChangeEvent(store, "main", "task/stuck", opened.head, {
      type: "stuck",
      at: new Date(),
      reason: "fixture needs repair",
    })
    await writeQueueEvent(store, "main", {
      type: "paused",
      cause: "stuck",
      by: "@chief",
      reason: "repair task/stuck",
      at: new Date(),
      change: { branch: "task/stuck", head: w.target, event: stuck },
    })
    const trace = traceRemoteCalls(join(w.root, "trace-stuck"), { seams: true })
    let calls: ReturnType<typeof trace.end>
    try {
      const result = await submit(w.git, "origin", request)
      expect(result.stop).toMatchObject({ cause: "stuck", change: { branch: "task/stuck", head: w.target } })
    } finally {
      calls = trace.end()
    }
    expect(calls.seams.submitEvent?.fetch ?? 0).toBeGreaterThan(0)
  })

  it("refreshes and refuses maintenance that lands after the listing", async () => {
    const w = await world()
    const store = createEventStore(w.work, "origin", selectionFor(w.git))
    const before = (await readEventQueue(store, "main")).tip
    const paused = await writeQueueEvent(store, "main", {
      type: "paused",
      by: "@chief",
      cause: "maintenance",
      reason: "migration after listing",
      at: new Date(),
    })
    await w.git(["-C", w.remote, "update-ref", queueRef("main"), before, paused])
    const script = join(w.root, "git-maintenance-race.sh")
    const marker = join(w.root, "maintenance-pending")
    writeFileSync(marker, "pending\n")
    writeFileSync(
      script,
      `#!/bin/sh\ncase " $* " in\n  *ls-remote*refs/yrd/main/*)
    if [ "\${YRD_SEAM-}" = submitEvent ] && [ -f '${marker}' ]; then
      git "$@" > '${w.root}/listed' || exit $?
      git -C '${w.remote}' update-ref '${queueRef("main")}' '${paused}' '${before}' || exit $?
      rm '${marker}'
      cat '${w.root}/listed'
      exit 0
    fi;;
esac
exec git "$@"
`,
    )
    chmodSync(script, 0o755)
    const runner = gitIn(w.work, undefined, { ...selectionFor(w.git), executable: script })
    const trace = traceRemoteCalls(join(w.root, "trace-maintenance"), { seams: true })
    try {
      await expect(submit(runner, "origin", request)).rejects.toThrow(/submission stopped for maintenance/u)
    } finally {
      trace.end()
    }
    expect(existsSync(marker)).toBe(false)
    await noPublication(w)
  })

  /** @failure A CAS conflict duplicates the queue projection and lifts a submit over twenty SSH children (26231). */
  it("bounds publication reads when an operator pause lands after the queue listing", async () => {
    const w = await world()
    const store = createEventStore(w.work, "origin", selectionFor(w.git))
    const before = (await readEventQueue(store, "main")).tip
    const paused = await writeQueueEvent(store, "main", {
      type: "paused",
      by: "@chief",
      cause: "operator",
      reason: "routine pause after listing",
      at: new Date(),
    })
    await w.git(["-C", w.remote, "update-ref", queueRef("main"), before, paused])
    const script = join(w.root, "git-operator-race.sh")
    const marker = join(w.root, "operator-pending")
    writeFileSync(marker, "pending\n")
    writeFileSync(
      script,
      `#!/bin/sh\ncase " $* " in\n  *ls-remote*refs/yrd/main/*)
    if [ "\${YRD_SEAM-}" = submitEvent ] && [ -f '${marker}' ]; then
      git "$@" > '${w.root}/listed' || exit $?
      git -C '${w.remote}' update-ref '${queueRef("main")}' '${paused}' '${before}' || exit $?
      rm '${marker}'
      cat '${w.root}/listed'
      exit 0
    fi;;
esac
exec git "$@"
`,
    )
    chmodSync(script, 0o755)
    const runner = gitIn(w.work, undefined, { ...selectionFor(w.git), executable: script })
    const trace = traceRemoteCalls(join(w.root, "trace-operator-race"), { seams: true })
    let calls: ReturnType<typeof trace.end>
    try {
      const result = await submit(runner, "origin", request)
      expect(result.retry).toBe(false)
      expect(result.stop?.cause).toBe("operator")
    } finally {
      calls = trace.end()
    }
    expect(existsSync(marker)).toBe(false)
    expect(
      (await readEventChain(await openEvents({ ...store, ref: changesRef("main", request.branch) }))).map(
        (event) => event.type,
      ),
    ).toEqual(["opened"])
    const publication = calls.seams.submitEvent
    const remoteCalls = (publication?.["ls-remote"] ?? 0) + (publication?.fetch ?? 0) + (publication?.push ?? 0)
    expect(remoteCalls, JSON.stringify(publication)).toBeLessThanOrEqual(12)
    expect(calls.unreadable).toBe(0)
  })

  it("fails loudly when the fresh prefix listing fails", async () => {
    const w = await world()
    const script = join(w.root, "git-listing-fail.sh")
    const marker = join(w.root, "listing-pending")
    writeFileSync(marker, "pending\n")
    writeFileSync(
      script,
      `#!/bin/sh\ncase " $* " in\n  *ls-remote*refs/yrd/main/*)
    if [ "\${YRD_SEAM-}" = submitEvent ] && [ -f '${marker}' ]; then
      rm '${marker}'
      echo 'fixture fresh prefix listing failed' >&2
      exit 73
    fi;;
esac
exec git "$@"
`,
    )
    chmodSync(script, 0o755)
    const runner = gitIn(w.work, undefined, { ...selectionFor(w.git), executable: script })
    const trace = traceRemoteCalls(join(w.root, "trace-fail"), { seams: true })
    try {
      await expect(submit(runner, "origin", request)).rejects.toThrow(/fixture fresh prefix listing failed/u)
    } finally {
      trace.end()
    }
    expect(existsSync(marker)).toBe(false)
    await noPublication(w)
  })
})
