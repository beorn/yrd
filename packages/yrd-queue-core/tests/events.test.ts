// @failure an event queue can show a stored status, accept a deciding event after an ending,
// or leave two changes open on one branch after resubmission.
// @level l1
// @consumer yrd list, submit and the queue runner on ADR-0016 event queues

import { describe, expect, it } from "vitest"
import type { Event, EventInput } from "gitomic/events"
import { listRefs, openEvents } from "gitomic/events"
import { createMemBackend } from "gitomic/mem"
import { Conflict, open } from "gitomic"
import type { GitomicBackend } from "gitomic"
import { gitIn } from "../src/git.ts"
import {
  CHANGE_EVENT_TYPES,
  appendChangeEvent,
  changeInput,
  changesRef,
  decide,
  drop,
  evolve,
  initial,
  listChangeHistories,
  listChanges,
  queueFormat,
  queueRef,
  readEventQueue,
  readStatus,
  setBranchIgnored,
  writeQueueEvent,
} from "../src/events.ts"

const A = "a".repeat(40)
const B = "b".repeat(40)

function remoteMemStore(repo: string) {
  const backend = createMemBackend()
  const localRefs = backend.listRefs
  const localPublish = backend.publish
  if (localRefs === undefined || localPublish === undefined) throw new Error("mem backend lacks event ref operations")
  let beforePublish: (() => Promise<void>) | undefined
  const proxy: GitomicBackend = {
    ...backend,
    listRefs: (name, prefix) => localRefs(name, prefix),
    publish: async (name, updates) => {
      const hook = beforePublish
      beforePublish = undefined
      if (hook !== undefined) await hook()
      return localPublish(name, updates)
    },
    fetchRefs: async (name, refs) => {
      if (typeof refs === "string") return localRefs(name, refs)
      const found = new Map<string, string>()
      for (const ref of refs) {
        const oid = (await localRefs(name, ref)).get(ref)
        if (oid === undefined) throw new Error(`missing fixture ref ${ref}`)
        found.set(ref, oid)
      }
      return found
    },
  }
  const store = { repo, backend: proxy }
  return {
    store,
    location: { ...store, remote: "origin", selection: gitIn(repo).selection },
    beforeNextPublish: (hook: () => Promise<void>) => (beforePublish = hook),
  }
}

const FIXTURE_IDENT = { name: "yrd fixture", email: "fixture@yrd.invalid" } as const

function event(
  type: string,
  id: string,
  props: readonly (readonly [string, string])[] = [],
  links: string[] = [],
): Event {
  return {
    id,
    parent: null,
    links,
    type,
    title: type,
    content: "",
    props: [
      ...(props.some(([key]) => key === "Queue") ? [] : [["Queue", A] as const]),
      ...(props.some(([key]) => key === "Time") ? [] : [["Time", "2026-09-22T14:00:00.000Z"] as const]),
      ...(type === "opened" && !props.some(([key]) => key === "By") ? [["By", "@dev/2"] as const] : []),
      ...props,
    ],
    writer: "yrd",
    instance: null,
    seq: null,
    author: FIXTURE_IDENT,
    committer: FIXTURE_IDENT,
  }
}

/** Seed a queue chain in the memory backend; createEventQueue's config guard is covered against real Git. */
async function seedEventQueue(
  location: Readonly<{ repo: string; remote: string; backend?: GitomicBackend }>,
  queue: string,
  commit: string,
  at: Date,
): Promise<string> {
  const result = await (
    await openEvents({ ...location, ref: queueRef(queue), writer: "yrd" })
  ).append(
    [
      {
        type: "created",
        props: [
          ["Commit", commit],
          ["Time", at.toISOString()],
        ],
        keeps: [commit],
      },
    ],
    { expect: null },
  )
  const created = result.events[0]?.id
  if (created === undefined) throw new Error("fixture created event was not written")
  return created
}

function input(type: string, props: readonly (readonly [string, string])[] = [], keeps: string[] = []): EventInput {
  return {
    type,
    props: [
      ["Queue", A],
      ["Time", "2026-09-22T14:00:00.000Z"],
      ...(type === "opened" ? [["By", "@dev/2"] as const] : []),
      ...props,
    ],
    keeps,
  }
}

function landed(inputs: readonly EventInput[], firstId: string): Event[] {
  return inputs.map((input, index) =>
    event(input.type, `${index}${firstId.slice(1)}`, input.props, [...(input.keeps ?? [])]),
  )
}

describe("ADR-0017 ref tree", () => {
  it("has a queue chain and exactly one change chain per branch, with queue encoding", () => {
    expect(queueRef("feature/main")).toBe("refs/yrd/feature%2Fmain/queue")
    expect(changesRef("feature/main", "task/42-one")).toBe("refs/yrd/feature%2Fmain/changes/task/42-one")
    expect(() => changesRef("main", "../escape")).toThrow(/branch/)
  })
})

describe("ADR-0016 event fold", () => {
  it("keeps the approved change-event vocabulary exact", () => {
    expect(CHANGE_EVENT_TYPES).toEqual([
      "opened",
      "verifying",
      "checking",
      "merging",
      "merged",
      "failed",
      "stuck",
      "cancelled",
      "ignored",
      "unignored",
    ])
  })

  it("constructs required Yrd trailers and kept commits for a write", () => {
    const at = new Date("2026-09-22T14:00:00.000Z")
    const opened = changeInput("opened", { queueTip: A, at, commit: B, issue: "25040", by: "@dev/2" })
    expect(opened.props).toEqual([
      ["Queue", A],
      ["Time", at.toISOString()],
      ["Commit", B],
      ["Issue", "25040"],
      ["By", "@dev/2"],
    ])
    expect(opened.keeps).toEqual([B])
    expect(changeInput("checking", { queueTip: A, at }).props).toEqual([
      ["Queue", A],
      ["Time", at.toISOString()],
    ])
    expect(() => changeInput("opened", { queueTip: A, at, by: "@dev/2" })).toThrow(/Commit/)
    expect(() => changeInput("opened", { queueTip: A, at, commit: B })).toThrow(/By/)
    const resubmit = decide([event("opened", A, [["Commit", A]], [A])], opened)
    expect(resubmit[0]?.props).toContainEqual(["Queue", A])
    expect(resubmit[0]?.props).toContainEqual(["Time", at.toISOString()])
  })

  it("derives phases and endings without a Status trailer", () => {
    const opened = event("opened", A, [["Commit", A]], [A])
    const verifying = event("verifying", B, [["Commit", B]], [B])
    const queued = evolve(initial, opened)
    expect(queued.status).toBe("queued")
    expect(evolve(queued, verifying).status).toBe("verifying")
    expect(evolve(evolve(queued, verifying), event("checking", "c".repeat(40))).status).toBe("checking")
    expect(() => evolve(queued, event("checking", "c".repeat(40)))).toThrow(/checking.*verifying/)
    expect(evolve(queued, event("failed", B)).status).toBe("failed")
    expect(() =>
      evolve(
        initial,
        event(
          "opened",
          A,
          [
            ["Status", "queued"],
            ["Commit", A],
          ],
          [A],
        ),
      ),
    ).toThrow(/Status/)
    expect(() => evolve(initial, event("merged", B))).toThrow(/opened/)
    expect(() => evolve(initial, { ...opened, props: [["Commit", A]] })).toThrow(/Queue/)
    expect(() =>
      evolve(initial, {
        ...opened,
        props: [
          ["Queue", A],
          ["Commit", A],
        ],
      }),
    ).toThrow(/Time/)
  })

  it("keeps ignore attribution separate from a change's reason and refuses malformed overlays", () => {
    const opened = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const failedCheck = evolve(
      opened,
      event(
        "verifying",
        B,
        [
          ["Commit", B],
          ["Reason", "rechecking"],
        ],
        [B],
      ),
    )
    const ignored = evolve(
      failedCheck,
      event("ignored", "c".repeat(40), [
        ["Reason", "waiting"],
        ["By", "@dev/2"],
      ]),
    )
    expect(ignored).toMatchObject({ status: "verifying", ignored: { reason: "waiting", by: "@dev/2" } })
    expect(ignored.reason).toBe("rechecking")
    expect(() =>
      evolve(
        ignored,
        event("ignored", "d".repeat(40), [
          ["Reason", "again"],
          ["By", "@dev/2"],
        ]),
      ),
    ).toThrow(/yrd-ignore-state-unchanged/u)
    expect(evolve(ignored, event("unignored", "e".repeat(40), [["By", "@dev/3"]])).ignored).toBeUndefined()
    expect(() => evolve(opened, event("ignored", "f".repeat(40), [["Reason", "why"]]))).toThrow(
      /yrd-ignore-event-malformed:.*By:/u,
    )
    expect(() =>
      evolve(
        opened,
        event("unignored", "f".repeat(40), [
          ["By", "@dev/2"],
          ["Reason", "why"],
        ]),
      ),
    ).toThrow(/yrd-ignore-event-malformed:.*Reason:/u)
    const ended = evolve(opened, event("failed", "f".repeat(40), [["Reason", "check failed"]]))
    expect(() =>
      evolve(
        ended,
        event("ignored", "1".repeat(40), [
          ["By", "@dev/2"],
          ["Reason", "waiting"],
        ]),
      ),
    ).toThrow(/yrd-ignore-change-ended/u)
  })

  it("re-verifies an interrupted checking or merging change with its new kept candidate", () => {
    const queued = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const first = evolve(queued, event("verifying", B, [["Commit", B]], [B]))
    expect(first.candidate).toBe(B)
    const checking = evolve(first, event("checking", "c".repeat(40)))
    const second = evolve(checking, event("verifying", "d".repeat(40), [["Commit", A]], [A]))
    expect(second).toMatchObject({ status: "verifying", candidate: A, commit: A })
    const merging = evolve(checking, event("merging", "e".repeat(40)))
    const third = evolve(merging, event("verifying", "f".repeat(40), [["Commit", B]], [B]))
    expect(third).toMatchObject({ status: "verifying", candidate: B, commit: A })
  })

  it("recognizes an observed target merge after a verified candidate failed", () => {
    const queued = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const verified = evolve(queued, event("verifying", B, [["Commit", B]], [B]))
    const failed = evolve(verified, event("failed", "c".repeat(40)))
    const targetMerge = "e".repeat(40)
    const merged = evolve(
      failed,
      event(
        "merged",
        "d".repeat(40),
        [
          ["Commit", targetMerge],
          ["Reason", `observed on target at ${targetMerge}`],
        ],
        [targetMerge],
      ),
    )
    expect(merged).toMatchObject({ status: "merged", commit: A, candidate: B })
    expect(() => evolve(failed, event("merged", "f".repeat(40), [["Commit", targetMerge]], [targetMerge]))).toThrow(
      /observed target commit/,
    )
  })

  it("cancels the prior open change before a second opened event", () => {
    const current = [event("opened", A, [["Commit", A]], [A])]
    const next = decide(current, input("opened", [["Commit", B]], [B]))
    expect(next.map((input) => input.type)).toEqual(["cancelled", "opened"])
    expect(next[0]?.props).toContainEqual(["Reason", "resubmitted"])
    const ended = landed(next, B).reduce(evolve, current.reduce(evolve, initial))
    expect(ended.status).toBe("queued")
    expect(ended.commit).toBe(B)
  })

  it("refuses deciding events after an ending with its kind and sha, but allows reopen and observed merge", () => {
    const current = [event("opened", A, [["Commit", A]], [A]), event("failed", B)]
    for (const kind of ["verifying", "checking", "merging", "stuck", "failed", "cancelled"]) {
      expect(() => decide(current, input(kind)), kind).toThrow(/failed.*bbbbbbbb/)
    }
    expect(() => decide(current, input("merged"))).toThrow(/Commit/)
    expect(decide(current, input("merged", [["Commit", A]], [A])).map((input) => input.type)).toEqual(["merged"])
    expect(decide(current, input("opened", [["Commit", B]], [B])).map((input) => input.type)).toEqual(["opened"])
  })

  it("requires an event to keep each commit it records", () => {
    expect(() => decide([], input("opened", [["Commit", A]]))).toThrow(/keep/)
    expect(() => decide([], input("opened", [], [A]))).toThrow(/Commit/)
    expect(() => decide([event("opened", A, [["Commit", A]], [A])], input("verifying", [["Commit", B]]))).toThrow(
      /keep/,
    )
  })

  it("a stuck change refuses another phase while drop remains an escape", () => {
    const opened = event("opened", A, [["Commit", A]], [A])
    const stuck = event("stuck", B, [["Reason", "needs-operator"]])
    const current = [opened, stuck]
    expect(current.reduce(evolve, initial).status).toBe("stuck")
    expect(() => decide(current, input("checking"))).toThrow(/stuck.*merge or cancel/)
    const [dropped] = decide(
      current,
      input(
        "cancelled",
        [
          ["Reason", "dropped"],
          ["Commit", A],
        ],
        [A],
      ),
    )
    if (dropped === undefined) throw new Error("drop decision produced no event")
    expect(
      evolve(current.reduce(evolve, initial), event(dropped.type, "c".repeat(40), dropped.props ?? [], [A])).status,
    ).toBe("cancelled")
  })

  it("records a dropped branch with no prior submit as a cancelled chain that keeps its last head", () => {
    const dropped = event(
      "cancelled",
      B,
      [
        ["Reason", "dropped"],
        ["Commit", A],
      ],
      [A],
    )
    const state = evolve(initial, dropped)
    expect(state).toMatchObject({ status: "cancelled", commit: A, reason: "dropped", ending: { id: B } })
    expect(() =>
      evolve(
        initial,
        event(
          "cancelled",
          B,
          [
            ["Reason", "deleted"],
            ["Commit", A],
          ],
          [A],
        ),
      ),
    ).toThrow(/open change/)
  })

  it("does not carry an earlier submission's attribution onto a later branch drop", () => {
    const ended = [
      event(
        "opened",
        A,
        [
          ["Commit", A],
          ["Issue", "25040"],
        ],
        [A],
      ),
      event("failed", B),
    ].reduce(evolve, initial)
    const dropped = evolve(
      ended,
      event(
        "cancelled",
        "c".repeat(40),
        [
          ["Reason", "dropped"],
          ["Commit", B],
        ],
        [B],
      ),
    )
    expect(dropped).toMatchObject({ status: "cancelled", commit: A, reason: "dropped" })
    expect(dropped.issue).toBeUndefined()
    expect(dropped.submitter).toBeUndefined()
    expect(dropped.since).toBeUndefined()
    expect(evolve(dropped, event("merged", "d".repeat(40), [["Commit", A]], [A])).status).toBe("merged")
  })
})

describe("the queue-format boundary", () => {
  it("drops a branch in the same publish as an ending that keeps its last commit", async () => {
    const { store, location } = remoteMemStore("yrd-event-drop")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: "refs/heads/task/drop" })
    const head = (await branch.transact(async (map) => map.set("work", "one"), "work")).oid
    await (
      await openEvents({ ...store, ref: changesRef("lab", "task/drop") })
    ).append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head, by: "@dev/2" })],
      {
        expect: null,
      },
    )
    const last = (await branch.transact(async (map) => map.set("work", "two"), "push after submit")).oid
    const dropped = await drop(location, { queue: "lab", branch: "task/drop", by: "@dev/2" })
    expect((await readStatus(location, "lab", "task/drop")).reason).toBe("dropped")
    expect((await readStatus(location, "lab", "task/drop")).commit).toBe(head)
    expect((await listRefs("refs/heads/task/drop", store)).has("refs/heads/task/drop")).toBe(false)
    expect((await (await openEvents({ ...store, ref: changesRef("lab", "task/drop") })).events()).at(-1)).toMatchObject(
      {
        id: dropped.event,
        type: "cancelled",
        links: [last],
      },
    )
    expect(await drop(location, { queue: "lab", branch: "task/drop", by: "@dev/2" })).toEqual(dropped)
  })

  it("drops a never-submitted branch by creating its chain, then reports the ending on retry", async () => {
    const { store, location } = remoteMemStore("yrd-event-drop-draft")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: "refs/heads/task/draft" })
    const head = (await branch.transact(async (map) => map.set("work", "one"), "work")).oid
    const dropped = await drop(location, { queue: "lab", branch: "task/draft", by: "@dev/2" })
    expect(await readStatus(location, "lab", "task/draft")).toMatchObject({
      status: "cancelled",
      commit: head,
      reason: "dropped",
    })
    expect((await listRefs("refs/heads/task/draft", store)).size).toBe(0)
    const events = await (await openEvents({ ...store, ref: changesRef("lab", "task/draft") })).events()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: dropped.event, type: "cancelled", links: [head] })
    expect(await drop(location, { queue: "lab", branch: "task/draft", by: "@dev/2" })).toEqual(dropped)
  })

  it("leaves the chain and moved branch untouched when the delete lease loses", async () => {
    const { store, location, beforeNextPublish } = remoteMemStore("yrd-event-drop-race")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: "refs/heads/task/race" })
    await branch.transact(async (map) => map.set("work", "one"), "first head")
    let rival = ""
    beforeNextPublish(async () => {
      rival = (await branch.transact(async (map) => map.set("work", "two"), "rival head")).oid
    })
    const refused = drop(location, { queue: "lab", branch: "task/race", by: "@dev/2" })
    await expect(refused).rejects.toBeInstanceOf(Conflict)
    await expect(refused).rejects.toThrow(new RegExp(`refs/heads/task/race.*${rival}`))
    expect(await branch.head()).toBe(rival)
    expect(await (await openEvents({ ...store, ref: changesRef("lab", "task/race") })).head()).toBeNull()
  })

  it("names the deleted-branch disposition when an open change lost its branch", async () => {
    const { store, location } = remoteMemStore("yrd-event-drop-absent")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const branchRef = "refs/heads/task/absent"
    const branch = await open({ ...store, ref: branchRef })
    const head = (await branch.transact(async (map) => map.set("work", "one"), "work")).oid
    const chain = await openEvents({ ...store, ref: changesRef("lab", "task/absent") })
    const opened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head, by: "@dev/2" })],
      { expect: null },
    )
    if (store.backend.publish === undefined) throw new Error("fixture backend cannot delete a ref")
    await store.backend.publish(store.repo, [{ ref: branchRef, expect: head, oid: null }])
    await expect(drop(location, { queue: "lab", branch: "task/absent", by: "@dev/2" })).rejects.toThrow(
      /refs\/heads\/task\/absent.*cancelled \(deleted\).*deleted-branch observer/,
    )
    expect(await chain.head()).toBe(opened.head)
    expect((await readStatus(location, "lab", "task/absent")).status).toBe("queued")
    const failed = await chain.append(
      [changeInput("failed", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), reason: "check failed" })],
      { expect: opened.head },
    )
    await expect(drop(location, { queue: "lab", branch: "task/absent", by: "@dev/2" })).rejects.toThrow(
      /refs\/heads\/task\/absent.*already ended failed.*no branch to drop/,
    )
    expect(await chain.head()).toBe(failed.head)
  })

  it("writes a runner phase at the selected tip and keeps its candidate, then refuses a stale rival", async () => {
    const { store, location } = remoteMemStore("yrd-event-run-writer")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const targetCommit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const queueTip = await seedEventQueue(location, "lab", targetCommit, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: "refs/heads/task/42" })
    const head = (await branch.transact(async (map) => map.set("work.txt", "one"), "work")).oid
    const candidate = await open({ ...store, ref: "refs/heads/candidate" })
    const composed = (await candidate.transact(async (map) => map.set("work.txt", "composed"), "compose")).oid
    const ref = changesRef("lab", "task/42")
    const chain = await openEvents({ ...store, ref })
    const opened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head, by: "@dev/2" })],
      { expect: null },
    )
    const selectedTip = opened.head
    if (selectedTip === null) throw new Error("fixture opened event has no tip")
    const verifying = await appendChangeEvent(location, "lab", "task/42", selectedTip, {
      type: "verifying",
      at: new Date("2026-09-22T14:02:00.000Z"),
      commit: composed,
    })
    expect((await readStatus(location, "lab", "task/42")).status).toBe("verifying")
    expect((await chain.events()).at(-1)).toMatchObject({ id: verifying, type: "verifying", links: [composed] })
    await expect(
      appendChangeEvent(location, "lab", "task/42", selectedTip, {
        type: "checking",
        at: new Date("2026-09-22T14:03:00.000Z"),
      }),
    ).rejects.toThrow(/moved after the selected reading/)
    const checking = await appendChangeEvent(location, "lab", "task/42", verifying, {
      type: "checking",
      at: new Date("2026-09-22T14:03:00.000Z"),
    })
    expect(checking).toMatch(/^[0-9a-f]{40}$/u)
    expect((await readStatus(location, "lab", "task/42")).status).toBe("checking")
    const merging = await appendChangeEvent(location, "lab", "task/42", checking, {
      type: "merging",
      at: new Date("2026-09-22T14:04:00.000Z"),
    })
    const merged = {
      type: "merged" as const,
      at: new Date("2026-09-22T14:05:00.000Z"),
      commit: composed,
      also: [{ ref: "refs/heads/lab", expect: A, oid: composed }],
    }
    await expect(appendChangeEvent(location, "lab", "task/42", merging, merged)).rejects.toThrow()
    expect((await readStatus(location, "lab", "task/42")).status).toBe("merging")
    expect(await target.head()).toBe(targetCommit)
    await expect(
      appendChangeEvent(location, "lab", "task/42", merging, {
        ...merged,
        commit: head,
        also: [{ ref: "refs/heads/lab", expect: targetCommit, oid: composed }],
      }),
    ).rejects.toThrow(/candidate/)
    await appendChangeEvent(location, "lab", "task/42", merging, {
      ...merged,
      also: [{ ref: "refs/heads/lab", expect: targetCommit, oid: composed }],
    })
    expect((await readStatus(location, "lab", "task/42")).status).toBe("merged")
    expect(await target.head()).toBe(composed)
  })

  it("refuses a stuck event if a queue resume raced its causal queue tip", async () => {
    const { store, location, beforeNextPublish } = remoteMemStore("yrd-event-stuck-resume-race")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const targetCommit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const queueTip = await seedEventQueue(location, "lab", targetCommit, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: "refs/heads/task/42" })
    const head = (await branch.transact(async (map) => map.set("work.txt", "one"), "work")).oid
    const ref = changesRef("lab", "task/42")
    const opened = await (
      await openEvents({ ...store, ref })
    ).append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head, by: "@dev/2" })],
      { expect: null },
    )
    if (opened.head === null) throw new Error("fixture opened event has no tip")
    beforeNextPublish(async () => {
      await writeQueueEvent(location, "lab", { type: "paused", by: "operator", reason: "repair", at: new Date() })
      await writeQueueEvent(location, "lab", { type: "resumed", by: "operator", reason: "repaired", at: new Date() })
    })

    await expect(
      appendChangeEvent(location, "lab", "task/42", opened.head, {
        type: "stuck",
        at: new Date(),
        reason: "needs repair",
      }),
    ).rejects.toThrow()
    expect((await readStatus(location, "lab", "task/42")).status).toBe("queued")
  })

  it("requires a declared queue chain and derives its pause from queue events", async () => {
    const { store, location } = remoteMemStore("yrd-event-queue")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const created = await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    expect((await readEventQueue(location, "lab")).created).toBe(created)
    await writeQueueEvent(location, "lab", {
      type: "paused",
      reason: "repair",
      by: "operator",
      at: new Date("2026-09-22T14:01:00.000Z"),
    })
    expect((await readEventQueue(location, "lab")).pause?.reason).toBe("repair")
    expect((await readEventQueue(location, "lab")).pause?.by).toBe("operator")
    await writeQueueEvent(location, "lab", {
      type: "resumed",
      reason: "repaired",
      by: "operator",
      at: new Date("2026-09-22T14:02:00.000Z"),
    })
    expect((await readEventQueue(location, "lab")).pause).toBeUndefined()
    await expect(
      writeQueueEvent(location, "lab", {
        type: "resumed",
        reason: "again",
        by: "operator",
        at: new Date("2026-09-22T14:03:00.000Z"),
      }),
    ).rejects.toThrow(/resumes a running queue/)
  })

  it("selects one event queue by its queue ref and reads an empty change set without legacy fallback", async () => {
    const { store, location } = remoteMemStore("yrd-event-selector")
    expect(await queueFormat(location, "lab")).toBe("legacy")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const targetCommit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", targetCommit, new Date("2026-09-22T14:00:00.000Z"))
    expect(await queueFormat(location, "lab")).toBe("event")
    expect(await listChanges(location, "lab")).toEqual(new Map())
    await expect(readStatus(location, "lab", "missing")).rejects.toThrow(
      /missing event chain.*refs\/yrd\/lab\/changes\/missing/,
    )

    const ref = changesRef("lab", "task/42")
    const branch = await openEvents({ ...store, ref })
    const work = await open({ ...store, ref: "refs/heads/task/42" })
    const commit = (await work.transact(async (map) => map.set("work.txt", "one"), "work")).oid
    await branch.append([input("opened", [["Commit", commit]], [commit])], { expect: null })
    expect((await listChanges(location, "lab")).get("task/42")?.status).toBe("queued")
    expect((await readStatus(location, "lab", "task/42")).status).toBe("queued")
    // Gitomic's reader defaults to 50; a status must fold the whole chain.
    const reports = Array.from({ length: 51 }, (_, index) =>
      index % 2 === 0
        ? input("ignored", [
            ["Reason", "fixture report"],
            ["By", "@dev/2"],
          ])
        : input("unignored", [["By", "@dev/2"]]),
    )
    await branch.append(reports, { expect: await branch.head() })
    expect((await listChanges(location, "lab")).get("task/42")?.status).toBe("queued")
    expect((await readStatus(location, "lab", "task/42")).status).toBe("queued")
  })

  it("reuses only a validated queue read from the same location", async () => {
    const first = remoteMemStore("yrd-event-first")
    const second = remoteMemStore("yrd-event-second")
    const target = await open({ ...first.store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(first.location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const queue = await readEventQueue(first.location, "lab")
    expect(await listChangeHistories(first.location, "lab", { knownQueue: queue })).toEqual(new Map())
    await expect(listChangeHistories(second.location, "lab", { knownQueue: queue })).rejects.toThrow(
      /validated queue.*same location/,
    )
    await expect(listChangeHistories(first.location, "other", { knownQueue: queue })).rejects.toThrow(
      /validated queue.*same location/,
    )
    expect(await listChangeHistories(first.location, "lab")).toEqual(new Map())
  })

  it("ignores and unignores only an existing open change with a reason and actor", async () => {
    const { store, location } = remoteMemStore("yrd-event-ignore")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const request = { queue: "lab", branch: "task/42", by: "@dev/2" } as const
    await expect(setBranchIgnored(location, { ...request, ignored: true, reason: "waiting" })).rejects.toThrow(
      /yrd-ignore-change-missing:.*task\/42.*changes\/task\/42/u,
    )
    const branch = await openEvents({ ...store, ref: changesRef("lab", "task/42") })
    await branch.append([changeInput("opened", { queueTip, at: new Date(), commit: base, by: "@dev/2" })], {
      expect: null,
    })
    await expect(setBranchIgnored(location, { ...request, ignored: true, reason: "" })).rejects.toThrow(
      /yrd-ignore-reason-required/u,
    )
    await expect(
      setBranchIgnored(location, { ...request, ignored: false, reason: "invalid" } as never),
    ).rejects.toThrow(/yrd-ignore-reason-conflict/u)
    await expect(setBranchIgnored(location, { ...request, ignored: true, reason: "waiting" })).resolves.toBeUndefined()
    expect((await branch.events({ limit: 1024 })).map((event) => event.type)).toEqual(["opened", "ignored"])
    expect((await readStatus(location, "lab", "task/42")).ignored).toEqual({ reason: "waiting", by: "@dev/2" })
    await expect(setBranchIgnored(location, { ...request, ignored: true, reason: "again" })).rejects.toThrow(
      /yrd-ignore-state-unchanged/u,
    )
    await expect(setBranchIgnored(location, { ...request, ignored: false })).resolves.toBeUndefined()
    expect((await branch.events({ limit: 1024 })).map((event) => event.type)).toEqual([
      "opened",
      "ignored",
      "unignored",
    ])
    expect((await readStatus(location, "lab", "task/42")).ignored).toBeUndefined()
    await expect(setBranchIgnored(location, { ...request, ignored: false })).rejects.toThrow(
      /yrd-ignore-state-unchanged/u,
    )
    const selected = await branch.head()
    await branch.append([changeInput("failed", { queueTip, at: new Date(), reason: "check failed" })], {
      expect: selected,
    })
    await expect(setBranchIgnored(location, { ...request, ignored: true, reason: "again" })).rejects.toThrow(
      /yrd-ignore-change-ended/u,
    )
  })

  it("loses the ignore write when a rival advances the selected change tip", async () => {
    const { store, location, beforeNextPublish } = remoteMemStore("yrd-event-ignore-race")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await openEvents({ ...store, ref: changesRef("lab", "task/race") })
    await branch.append([changeInput("opened", { queueTip, at: new Date(), commit: base, by: "@dev/2" })], {
      expect: null,
    })
    beforeNextPublish(async () => {
      await branch.append([changeInput("verifying", { queueTip, at: new Date(), commit: base })], {
        expect: await branch.head(),
      })
    })
    await expect(
      setBranchIgnored(location, { queue: "lab", branch: "task/race", by: "@dev/2", ignored: true, reason: "hold" }),
    ).rejects.toBeInstanceOf(Conflict)
    expect((await readStatus(location, "lab", "task/race")).ignored).toBeUndefined()
    expect((await readStatus(location, "lab", "task/race")).status).toBe("verifying")
  })

  it.each([true, false])("refuses ignored=%s while the change is landing", async (ignored) => {
    const { store, location } = remoteMemStore(`yrd-event-ignore-landing-${ignored}`)
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await openEvents({ ...store, ref: changesRef("lab", "task/landing") })
    const opened = await branch.append(
      [changeInput("opened", { queueTip, at: new Date(), commit: base, by: "@dev/2" })],
      { expect: null },
    )
    const request = { queue: "lab", branch: "task/landing", by: "@dev/2" } as const
    if (!ignored) await setBranchIgnored(location, { ...request, ignored: true, reason: "hold" })
    let selected = ignored ? opened.head : await branch.head()
    if (selected === null) throw new Error("fixture opened event has no tip")
    for (const type of ["verifying", "checking", "merging"] as const) {
      selected = await appendChangeEvent(location, "lab", "task/landing", selected, {
        type,
        at: new Date(),
        ...(type === "verifying" ? { commit: base } : {}),
      })
    }
    await expect(
      ignored
        ? setBranchIgnored(location, { ...request, ignored: true, reason: "hold" })
        : setBranchIgnored(location, { ...request, ignored: false }),
    ).rejects.toThrow(/yrd-ignore-change-landing:.*retry after it settles as merged, failed or stuck/u)
    expect(await branch.head()).toBe(selected)
  })

  it("refuses a present but malformed queue chain instead of showing empty changes", async () => {
    const { store, location } = remoteMemStore("yrd-event-malformed")
    const queue = await openEvents({ ...store, ref: queueRef("lab") })
    await queue.append([{ type: "created" }], { expect: null })
    expect(await queueFormat(location, "lab")).toBe("event")
    await expect(listChanges(location, "lab")).rejects.toThrow(/created.*Commit/)
  })
})
