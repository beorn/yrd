// @failure an event queue can show a stored status, accept a deciding event after an ending,
// or leave two changes open on one branch after resubmission.
// @level l1
// @consumer yrd list, submit and the queue runner on ADR-0016 event queues

import { describe, expect, it } from "vitest"
import type { Event, EventInput } from "gitomic/events"
import { openEvents } from "gitomic/events"
import { createMemBackend } from "gitomic/mem"
import { open } from "gitomic"
import { changesRef, decide, evolve, initial, listChanges, queueFormat, queueRef, readStatus } from "../src/events.ts"

const A = "a".repeat(40)
const B = "b".repeat(40)

function event(
  type: string,
  id: string,
  props: readonly (readonly [string, string])[] = [],
  links: string[] = [],
): Event {
  return { id, parent: null, links, type, title: type, content: "", props, writer: "yrd", instance: null, seq: null }
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
  it("derives phases and endings without a Status trailer", () => {
    const opened = event("opened", A, [["Commit", A]], [A])
    const verifying = event("verifying", B, [["Commit", B]], [B])
    const queued = evolve(initial, opened)
    expect(queued.status).toBe("queued")
    expect(evolve(queued, verifying).status).toBe("verifying")
    expect(evolve(evolve(queued, verifying), event("checking", "c".repeat(40))).status).toBe("checking")
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
  })

  it("cancels the prior open change before a second opened event", () => {
    const current = [event("opened", A, [["Commit", A]], [A])]
    const next = decide(current, { type: "opened", props: [["Commit", B]], keeps: [B] })
    expect(next.map((input) => input.type)).toEqual(["cancelled", "opened"])
    expect(next[0]?.props).toContainEqual(["Reason", "resubmitted"])
    const ended = landed(next, B).reduce(evolve, current.reduce(evolve, initial))
    expect(ended.status).toBe("queued")
    expect(ended.commit).toBe(B)
  })

  it("refuses deciding events after an ending with its kind and sha, but allows reports, reopen and observed merge", () => {
    const current = [event("opened", A, [["Commit", A]], [A]), event("failed", B)]
    for (const kind of ["verifying", "checking", "merging", "stuck", "failed", "cancelled"]) {
      expect(() => decide(current, { type: kind }), kind).toThrow(/failed.*bbbbbbbb/)
    }
    expect(decide(current, { type: "sent" }).map((input) => input.type)).toEqual(["sent"])
    expect(decide(current, { type: "merged" }).map((input) => input.type)).toEqual(["merged"])
    expect(decide(current, { type: "opened", props: [["Commit", B]], keeps: [B] }).map((input) => input.type)).toEqual([
      "opened",
    ])
  })

  it("requires an event to keep each commit it records", () => {
    expect(() => decide([], { type: "opened", props: [["Commit", A]] })).toThrow(/keep/)
    expect(() => decide([], { type: "opened", keeps: [A] })).toThrow(/Commit/)
    expect(() =>
      decide([event("opened", A, [["Commit", A]], [A])], { type: "verifying", props: [["Commit", B]] }),
    ).toThrow(/keep/)
  })
})

describe("the queue-format boundary", () => {
  it("selects one event queue by its queue ref and reads an empty change set without legacy fallback", async () => {
    const store = { repo: "yrd-event-selector", backend: createMemBackend() }
    expect(await queueFormat("lab", store)).toBe("legacy")
    const queue = await openEvents({ ...store, ref: queueRef("lab") })
    await queue.append([{ type: "created" }], { expect: null })
    expect(await queueFormat("lab", store)).toBe("event")
    expect(await listChanges("lab", store)).toEqual(new Map())
    await expect(readStatus("lab", "missing", store)).rejects.toThrow(
      /missing event chain.*refs\/yrd\/lab\/changes\/missing/,
    )

    const ref = changesRef("lab", "task/42")
    const branch = await openEvents({ ...store, ref })
    const work = await open({ ...store, ref: "refs/heads/task/42" })
    const commit = (await work.transact(async (map) => map.set("work.txt", "one"), "work")).oid
    await branch.append([{ type: "opened", props: [["Commit", commit]], keeps: [commit] }], { expect: null })
    expect((await listChanges("lab", store)).get("task/42")?.status).toBe("queued")
    expect((await readStatus("lab", "task/42", store)).status).toBe("queued")
    // Gitomic's reader defaults to 50; a status must fold the whole chain.
    const reports = Array.from({ length: 51 }, () => ({ type: "sent" }))
    await branch.append(reports, { expect: await branch.head() })
    expect((await listChanges("lab", store)).get("task/42")?.status).toBe("queued")
    expect((await readStatus("lab", "task/42", store)).status).toBe("queued")
  })
})
