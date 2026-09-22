// @failure an event queue can show a stored status, accept a deciding event after an ending,
// or leave two changes open on one branch after resubmission.
// @level l1
// @consumer yrd list, submit and the queue runner on ADR-0016 event queues

import { describe, expect, it } from "vitest"
import type { Event, EventInput } from "gitomic/events"
import { openEvents } from "gitomic/events"
import { createMemBackend } from "gitomic/mem"
import { open } from "gitomic"
import {
  appendChangeEvent,
  changeInput,
  changesRef,
  createEventQueue,
  decide,
  evolve,
  initial,
  listChanges,
  queueFormat,
  queueRef,
  readEventQueue,
  readStatus,
  writeQueueEvent,
} from "../src/events.ts"

const A = "a".repeat(40)
const B = "b".repeat(40)

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
      ...props,
    ],
    writer: "yrd",
    instance: null,
    seq: null,
  }
}

function input(type: string, props: readonly (readonly [string, string])[] = [], keeps: string[] = []): EventInput {
  return { type, props: [["Queue", A], ["Time", "2026-09-22T14:00:00.000Z"], ...props], keeps }
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
  it("constructs required Yrd trailers and kept commits for a write", () => {
    const at = new Date("2026-09-22T14:00:00.000Z")
    const opened = changeInput("opened", { queueTip: A, at, commit: B, issue: "25040" })
    expect(opened.props).toEqual([
      ["Queue", A],
      ["Time", at.toISOString()],
      ["Commit", B],
      ["Issue", "25040"],
    ])
    expect(opened.keeps).toEqual([B])
    expect(changeInput("checking", { queueTip: A, at }).props).toEqual([
      ["Queue", A],
      ["Time", at.toISOString()],
    ])
    expect(() => changeInput("opened", { queueTip: A, at })).toThrow(/Commit/)
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
    expect(evolve(evolve(queued, event("failed", B)), event("sent", "d".repeat(40))).status).toBe("failed")
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

  it("cancels the prior open change before a second opened event", () => {
    const current = [event("opened", A, [["Commit", A]], [A])]
    const next = decide(current, input("opened", [["Commit", B]], [B]))
    expect(next.map((input) => input.type)).toEqual(["cancelled", "opened"])
    expect(next[0]?.props).toContainEqual(["Reason", "resubmitted"])
    const ended = landed(next, B).reduce(evolve, current.reduce(evolve, initial))
    expect(ended.status).toBe("queued")
    expect(ended.commit).toBe(B)
  })

  it("refuses deciding events after an ending with its kind and sha, but allows reports, reopen and observed merge", () => {
    const current = [event("opened", A, [["Commit", A]], [A]), event("failed", B)]
    for (const kind of ["verifying", "checking", "merging", "stuck", "failed", "cancelled"]) {
      expect(() => decide(current, input(kind)), kind).toThrow(/failed.*bbbbbbbb/)
    }
    expect(decide(current, input("sent")).map((input) => input.type)).toEqual(["sent"])
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
})

describe("the queue-format boundary", () => {
  it("writes a runner phase at the selected tip and keeps its candidate, then refuses a stale rival", async () => {
    const store = { repo: "yrd-event-run-writer", backend: createMemBackend() }
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const targetCommit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const queueTip = await createEventQueue("lab", targetCommit, store, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: "refs/heads/task/42" })
    const head = (await branch.transact(async (map) => map.set("work.txt", "one"), "work")).oid
    const candidate = await open({ ...store, ref: "refs/heads/candidate" })
    const composed = (await candidate.transact(async (map) => map.set("work.txt", "composed"), "compose")).oid
    const ref = changesRef("lab", "task/42")
    const chain = await openEvents({ ...store, ref })
    const opened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head })],
      { expect: null },
    )
    const selectedTip = opened.head
    if (selectedTip === null) throw new Error("fixture opened event has no tip")
    const verifying = await appendChangeEvent(
      "lab",
      "task/42",
      selectedTip,
      {
        type: "verifying",
        at: new Date("2026-09-22T14:02:00.000Z"),
        commit: composed,
      },
      store,
    )
    expect((await readStatus("lab", "task/42", store)).status).toBe("verifying")
    expect((await chain.events()).at(-1)).toMatchObject({ id: verifying, type: "verifying", links: [composed] })
    await expect(
      appendChangeEvent(
        "lab",
        "task/42",
        selectedTip,
        {
          type: "checking",
          at: new Date("2026-09-22T14:03:00.000Z"),
        },
        store,
      ),
    ).rejects.toThrow(/moved after the selected reading/)
    const checking = await appendChangeEvent(
      "lab",
      "task/42",
      verifying,
      {
        type: "checking",
        at: new Date("2026-09-22T14:03:00.000Z"),
      },
      store,
    )
    expect(checking).toMatch(/^[0-9a-f]{40}$/u)
    expect((await readStatus("lab", "task/42", store)).status).toBe("checking")
    const merging = await appendChangeEvent(
      "lab",
      "task/42",
      checking,
      {
        type: "merging",
        at: new Date("2026-09-22T14:04:00.000Z"),
      },
      store,
    )
    const merged = {
      type: "merged" as const,
      at: new Date("2026-09-22T14:05:00.000Z"),
      commit: head,
      also: [{ ref: "refs/heads/lab", expect: A, oid: composed }],
    }
    await expect(appendChangeEvent("lab", "task/42", merging, merged, store)).rejects.toThrow()
    expect((await readStatus("lab", "task/42", store)).status).toBe("merging")
    expect(await target.head()).toBe(targetCommit)
    await appendChangeEvent(
      "lab",
      "task/42",
      merging,
      {
        ...merged,
        also: [{ ref: "refs/heads/lab", expect: targetCommit, oid: composed }],
      },
      store,
    )
    expect((await readStatus("lab", "task/42", store)).status).toBe("merged")
    expect(await target.head()).toBe(composed)
  })

  it("requires a declared queue chain and derives its pause from queue events", async () => {
    const store = { repo: "yrd-event-queue", backend: createMemBackend() }
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const created = await createEventQueue("lab", commit, store, new Date("2026-09-22T14:00:00.000Z"))
    expect((await readEventQueue("lab", store)).created).toBe(created)
    await writeQueueEvent(
      "lab",
      { type: "paused", reason: "repair", by: "operator", at: new Date("2026-09-22T14:01:00.000Z") },
      store,
    )
    expect((await readEventQueue("lab", store)).pause?.reason).toBe("repair")
    expect((await readEventQueue("lab", store)).pause?.by).toBe("operator")
    await writeQueueEvent(
      "lab",
      { type: "resumed", reason: "repaired", by: "operator", at: new Date("2026-09-22T14:02:00.000Z") },
      store,
    )
    expect((await readEventQueue("lab", store)).pause).toBeUndefined()
    await expect(
      writeQueueEvent(
        "lab",
        { type: "resumed", reason: "again", by: "operator", at: new Date("2026-09-22T14:03:00.000Z") },
        store,
      ),
    ).rejects.toThrow(/resumes a running queue/)
  })

  it("selects one event queue by its queue ref and reads an empty change set without legacy fallback", async () => {
    const store = { repo: "yrd-event-selector", backend: createMemBackend() }
    expect(await queueFormat("lab", store)).toBe("legacy")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const targetCommit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await createEventQueue("lab", targetCommit, store, new Date("2026-09-22T14:00:00.000Z"))
    expect(await queueFormat("lab", store)).toBe("event")
    expect(await listChanges("lab", store)).toEqual(new Map())
    await expect(readStatus("lab", "missing", store)).rejects.toThrow(
      /missing event chain.*refs\/yrd\/lab\/changes\/missing/,
    )

    const ref = changesRef("lab", "task/42")
    const branch = await openEvents({ ...store, ref })
    const work = await open({ ...store, ref: "refs/heads/task/42" })
    const commit = (await work.transact(async (map) => map.set("work.txt", "one"), "work")).oid
    await branch.append([input("opened", [["Commit", commit]], [commit])], { expect: null })
    expect((await listChanges("lab", store)).get("task/42")?.status).toBe("queued")
    expect((await readStatus("lab", "task/42", store)).status).toBe("queued")
    // Gitomic's reader defaults to 50; a status must fold the whole chain.
    const reports = Array.from({ length: 51 }, () => input("sent"))
    await branch.append(reports, { expect: await branch.head() })
    expect((await listChanges("lab", store)).get("task/42")?.status).toBe("queued")
    expect((await readStatus("lab", "task/42", store)).status).toBe("queued")
  })

  it("refuses a present but malformed queue chain instead of showing empty changes", async () => {
    const store = { repo: "yrd-event-malformed", backend: createMemBackend() }
    const queue = await openEvents({ ...store, ref: queueRef("lab") })
    await queue.append([{ type: "created" }], { expect: null })
    expect(await queueFormat("lab", store)).toBe("event")
    await expect(listChanges("lab", store)).rejects.toThrow(/created.*Commit/)
  })
})
