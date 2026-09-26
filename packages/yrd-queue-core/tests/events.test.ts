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
import { eventListRows, eventRows } from "../src/event-table.ts"
import { pauseRef } from "../src/refs.ts"
import { encodeOps, type OpsState } from "../src/ops-state.ts"
import { queueResumedAfter, stuckReleaseReason } from "../src/index.ts"
import {
  CHANGE_EVENT_TYPES,
  adoptedChange,
  adoptedInput,
  appendChangeEvent,
  changeInput,
  changesRef,
  decide,
  enumerateChangeSegments,
  expireQueueOverrides,
  drop,
  eventPause,
  evolve,
  initial,
  listChangeHistories,
  listChanges,
  mergedHistoryCommits,
  queueFormat,
  queueRef,
  readChangeEvents,
  readEventQueue,
  readEventQueueWithChanges,
  readStatus,
  setBranchIgnored,
  writeQueueEvent,
  writeQueueOverride,
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

async function seedOpsCutover(
  location: Readonly<{ repo: string; remote: string; backend?: GitomicBackend }>,
  queue: string,
  state: OpsState = { overrides: [] },
): Promise<string> {
  const previous = await readEventQueue(location as Parameters<typeof readEventQueue>[0], queue)
  const result = await (
    await openEvents({ ...location, ref: queueRef(queue), writer: "@chief" })
  ).append(
    [
      {
        type: "ops-cutover",
        props: [
          ["Queue", previous.tip],
          ["Time", "2026-09-22T14:00:30.000Z"],
          ["Ops", encodeOps(state)],
        ],
      },
    ],
    { expect: previous.tip },
  )
  const id = result.events[0]?.id
  if (id === undefined) throw new Error("fixture ops-cutover event was not written")
  return id
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
  it("enumerates every opened head segment without collapsing an older failed head", () => {
    const record = "c".repeat(40)
    const chain = [
      event("opened", "1".repeat(40), [["Commit", A]], [A]),
      event(
        "failed",
        "2".repeat(40),
        [
          ["Reason", "superseded"],
          ["Migrated-From", `refs/yrd/main/task/example@${A}@${record}`],
        ],
        [record],
      ),
      event("opened", "3".repeat(40), [["Commit", B]], [B]),
    ]
    const segments = enumerateChangeSegments(chain, "refs/yrd/main/changes/task/example", "fixture")
    expect(segments.map(({ head, state }) => [head, state.status])).toEqual([
      [A, "failed"],
      [B, "queued"],
    ])
    expect(segments.map(({ opened }) => opened)).toEqual(["1".repeat(40), "3".repeat(40)])
    expect(segments.map(({ sources }) => sources)).toEqual([
      [{ ref: `refs/yrd/main/task/example@${A}`, oid: record }],
      [],
    ])
  })

  it("accepts an unrecorded cancellation reason only with kept migration evidence", () => {
    const opened = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const source = "c".repeat(40)
    const migrated = event(
      "cancelled",
      B,
      [
        ["Reason", "unrecorded"],
        ["Migrated-From", `refs/yrd/main/task/example@${A}@${source}`],
      ],
      [source],
    )
    expect(evolve(opened, migrated).reason).toBe("unrecorded")
    expect(() => evolve(opened, event("cancelled", B, [["Reason", "unrecorded"]]))).toThrow(/cancelled needs Reason/)
  })

  it("keeps the approved change-event vocabulary exact", () => {
    expect(CHANGE_EVENT_TYPES).toEqual([
      "opened",
      "verifying",
      "checking",
      "merging",
      "merged",
      "failed",
      "stuck",
      "deferred",
      "cancelled",
      "ignored",
      "unignored",
      "notified",
      "adopted",
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

  it("keeps typed check evidence on the deciding event and refuses a false passing marker", () => {
    const at = new Date("2026-09-22T14:00:00.000Z")
    const run = { name: "unit", result: "fail" as const, exit: 1, durationMs: 42, log: "/tmp/removed/unit.log" }
    const failed = changeInput("failed", {
      queueTip: A,
      at,
      commit: B,
      checks: [{ run, attempt: 1, phase: "merge" }],
      base: A,
      config: B,
    })
    expect(failed.keeps).toEqual([B])
    expect(failed.props).toContainEqual([
      "Check",
      "unit exit=1 ms=42 result=fail attempt=1 phase=merge log=/tmp/removed/unit.log",
    ])
    expect(failed.props).toContainEqual(["Base", A])
    expect(failed.props).toContainEqual(["Config", B])
    expect(() =>
      changeInput("merging", {
        queueTip: A,
        at,
        commit: B,
        checks: [{ run, attempt: 1, phase: "merge" }],
        base: A,
        config: B,
      }),
    ).toThrow(/must all pass/u)
    expect(() => changeInput("stuck", { queueTip: A, at, retry: { retried: 1 } })).toThrow(
      /second Check: attempt|Retry-Reason:/u,
    )
    const retry = changeInput("stuck", { queueTip: A, at, retry: { retried: 1, reason: "remote read refused" } })
    expect(retry.props).toContainEqual(["Retried", "1"])
    expect(retry.props).toContainEqual(["Retry-Reason", "remote read refused"])
  })

  it("refuses a deciding row with an unrecognized execution tier", () => {
    const queued = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const verified = evolve(queued, event("verifying", B, [["Commit", B]], [B]))
    const checking = evolve(verified, event("checking", "c".repeat(40)))
    expect(() =>
      evolve(
        checking,
        event(
          "merging",
          "d".repeat(40),
          [
            ["Commit", B],
            ["Base", A],
            ["Config", B],
            ["Check", "unit exit=0 ms=42 result=pass attempt=1 phase=merge tier=fast log=/tmp/removed.log"],
          ],
          [B],
        ),
      ),
    ).toThrow(/Check:.*tier/u)
  })

  it("refuses duplicate result fields in retained check evidence", () => {
    const queued = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const verified = evolve(queued, event("verifying", B, [["Commit", B]], [B]))
    const checking = evolve(verified, event("checking", "c".repeat(40)))
    expect(() =>
      evolve(
        checking,
        event(
          "merging",
          "d".repeat(40),
          [
            ["Commit", B],
            ["Base", A],
            ["Config", B],
            ["Check", "unit exit=0 ms=42 result=pass result=fail attempt=1 phase=merge log=/tmp/removed.log"],
          ],
          [B],
        ),
      ),
    ).toThrow(/Check:.*repeats result/u)
  })

  it("requires both check attempts when a stuck event says Retried: 1", () => {
    const at = new Date("2026-09-22T14:00:00.000Z")
    const second = {
      run: { name: "remote", result: "stuck" as const, exit: 2, durationMs: 42, log: "/tmp/second.log" },
      attempt: 2,
      phase: "merge" as const,
    }
    expect(() =>
      changeInput("stuck", {
        queueTip: A,
        at,
        commit: B,
        checks: [second],
        base: A,
        config: B,
        retry: { retried: 1 },
      }),
    ).toThrow(/first Check: attempt/u)

    const queued = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const verified = evolve(queued, event("verifying", B, [["Commit", B]], [B]))
    const checking = evolve(verified, event("checking", "c".repeat(40)))
    expect(() =>
      evolve(
        checking,
        event(
          "stuck",
          "d".repeat(40),
          [
            ["Commit", B],
            ["Base", A],
            ["Config", B],
            ["Retried", "1"],
            ["Check", "remote exit=2 ms=42 result=stuck attempt=2 phase=merge log=/tmp/second.log"],
          ],
          [B],
        ),
      ),
    ).toThrow(/first Check: attempt/u)
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

  it("holds a deferred check in queued until a fresh verification or resubmission", () => {
    const queued = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const verifying = evolve(queued, event("verifying", B, [["Commit", B]], [B]))
    const checking = evolve(verifying, event("checking", "c".repeat(40)))
    expect(() =>
      evolve(
        checking,
        event(
          "deferred",
          "3".repeat(40),
          [
            ["Commit", B],
            ["Reason", "outside short window"],
            ["Check-Name", "affected-tests"],
            ["Phase", "submit"],
            ["ProjectedMs", "60000"],
            ["BoundMs", "10000"],
            ["Base", A],
            ["Config", B],
            ["Check", "affected-tests exit=unsettled ms=0 result=deferred attempt=1 phase=merge log=/tmp/removed.log"],
          ],
          [B],
        ),
      ),
    ).toThrow(/deferred.*Check:.*phase/u)
    const deferred = evolve(
      checking,
      event(
        "deferred",
        "d".repeat(40),
        [
          ["Commit", B],
          ["Reason", "outside short window"],
          ["Check-Name", "affected-tests"],
          ["Phase", "merge"],
          ["ProjectedMs", "60000"],
          ["BoundMs", "10000"],
          [
            "Check",
            "affected-tests exit=unsettled ms=0 result=deferred attempt=1 phase=merge log=/tmp/removed/affected-tests.log",
          ],
          ["Base", A],
          ["Config", B],
        ],
        [B],
      ),
    )
    expect(deferred).toMatchObject({
      status: "queued",
      candidate: B,
      deferred: {
        check: "affected-tests",
        phase: "merge",
        reason: "outside short window",
        projectedMs: 60000,
        boundMs: 10000,
      },
    })
    expect(deferred.deferred?.at.toISOString()).toBe("2026-09-22T14:00:00.000Z")
    const notice = evolve(
      deferred,
      event("notified", "2".repeat(40), [
        ["For", deferred.tip as string],
        ["To", "@dev/2"],
        ["Result", "refused"],
        ["Key", `${deferred.tip}:@dev/2`],
        ["Reason", "recipient unavailable"],
        ["Time", "2026-09-22T14:01:00.000Z"],
      ]),
    )
    expect(notice.status).toBe("queued")
    expect(notice.at).toEqual(deferred.at)
    expect(notice.notices?.[`${deferred.tip}:@dev/2`]?.result).toBe("refused")
    expect(evolve(deferred, event("verifying", "e".repeat(40), [["Commit", B]], [B])).deferred).toBeUndefined()
    const cancelled = evolve(deferred, event("cancelled", "f".repeat(40), [["Reason", "resubmitted"]]))
    expect(evolve(cancelled, event("opened", "1".repeat(40), [["Commit", A]], [A])).deferred).toBeUndefined()
  })

  it("records one settled notice without changing the verdict clock", () => {
    const queued = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const failed = evolve(queued, event("failed", B, [["Reason", "check failed"]]))
    const notice = event("notified", "c".repeat(40), [
      ["For", B],
      ["To", "@dev/2"],
      ["Result", "delivered"],
      ["Key", `${B}:@dev/2`],
      ["Time", "2026-09-22T14:01:00.000Z"],
    ])
    const notified = evolve(failed, notice)
    expect(notified).toMatchObject({ status: "failed", ending: { kind: "failed", id: B }, reason: "check failed" })
    expect(notified.at).toEqual(failed.at)
    expect(notified.endedAt).toEqual(failed.endedAt)
    expect(notified.tip).toBe(notice.id)
    expect(notified.notices?.[`${B}:@dev/2`]).toMatchObject({ for: B, to: "@dev/2", result: "delivered" })
    expect(() => evolve(notified, notice)).toThrow(/settled|duplicate/u)
    expect(() => evolve(queued, notice)).toThrow(/last notifiable/u)
    expect(evolve(notified, event("opened", "d".repeat(40), [["Commit", A]], [A])).notices).toBeUndefined()
    const merged = evolve(queued, event("merged", B, [["Commit", A]], [A]))
    expect(evolve(merged, notice)).toMatchObject({
      status: "merged",
      lastNotifiable: { id: B, kind: "merged" },
      notices: { [`${B}:@dev/2`]: { result: "delivered" } },
    })
  })

  it("settles multiple recipients for a stuck event while keeping the stop in place", () => {
    const queued = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const verified = evolve(queued, event("verifying", B, [["Commit", B]], [B]))
    const checking = evolve(verified, event("checking", "c".repeat(40)))
    const stuckId = "d".repeat(40)
    const stuck = evolve(checking, event("stuck", stuckId, [["Reason", "remote unavailable"]]))
    expect(stuck.lastNotifiable).toEqual({ id: stuckId, kind: "stuck" })
    const first = evolve(
      stuck,
      event("notified", "e".repeat(40), [
        ["For", stuckId],
        ["To", "@dev/2"],
        ["Result", "delivered"],
        ["Key", `${stuckId}:@dev/2`],
      ]),
    )
    const second = evolve(
      first,
      event("notified", "f".repeat(40), [
        ["For", stuckId],
        ["To", "@chief"],
        ["Result", "refused"],
        ["Key", `${stuckId}:@chief`],
        ["Reason", "recipient unavailable"],
      ]),
    )
    expect(second.status).toBe("stuck")
    expect(second.reason).toBe("remote unavailable")
    expect(second.at).toEqual(stuck.at)
    expect(second.lastNotifiable).toEqual({ id: stuckId, kind: "stuck" })
    expect(Object.keys(second.notices ?? {})).toHaveLength(2)
    const resumed = evolve(second, event("verifying", "1".repeat(40), [["Commit", B]], [B]))
    expect(resumed.lastNotifiable).toBeUndefined()
    expect(() =>
      evolve(
        resumed,
        event("notified", "2".repeat(40), [
          ["For", stuckId],
          ["To", "@dev/3"],
          ["Result", "delivered"],
          ["Key", `${stuckId}:@dev/3`],
        ]),
      ),
    ).toThrow(/last notifiable/u)
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
    const merging = evolve(checking, event("merging", "e".repeat(40), [["Commit", B]], [B]))
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

  it("carries the Run: trailer in merged changeInput and folds it onto state.run (25716 row 9)", () => {
    const runId = "2026-09-25T12:00:00.000Z-42"
    const input = changeInput("merged", {
      at: new Date("2026-09-25T12:05:00.000Z"),
      commit: A,
      queueTip: B,
      run: runId,
    })
    expect(input.props).toContainEqual(["Run", runId])
    const queued = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const merged = evolve(
      queued,
      event(
        "merged",
        B,
        [
          ["Commit", A],
          ["Run", runId],
        ],
        [A],
      ),
    )
    expect(merged.run).toBe(runId)
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

  // @failure dropping a draft creates a chain with no opened segment and blinds the whole queue listing (25658).
  it("drops a never-submitted branch with a readable opened segment, then reports the ending on retry", async () => {
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
    expect(events.map((event) => event.type)).toEqual(["opened", "cancelled"])
    expect(events[0]).toMatchObject({ type: "opened", links: [head] })
    expect(events[1]).toMatchObject({ id: dropped.event, type: "cancelled", links: [head] })
    const segments = enumerateChangeSegments(events, changesRef("lab", "task/draft"), store.repo)
    expect(eventListRows(new Map([["task/draft", segments.map((segment) => segment.state)]]), []).table).toMatchObject([
      { branch: "task/draft", state: "cancelled", head, reason: "dropped" },
    ])
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

  // @failure a drop after a failed ending replaces the failed notice event and stops the queue judge (25658).
  it("deletes an already-ended branch whose head is kept without changing its ending or queued notice", async () => {
    const { store, location } = remoteMemStore("yrd-event-drop-ended")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: "refs/heads/task/ended" })
    const head = (await branch.transact(async (map) => map.set("work", "one"), "work")).oid
    const chain = await openEvents({ ...store, ref: changesRef("lab", "task/ended") })
    const opened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head, by: "@dev/2" })],
      { expect: null },
    )
    const failed = await chain.append(
      [changeInput("failed", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), reason: "check failed" })],
      { expect: opened.head },
    )
    const before = await readStatus(location, "lab", "task/ended")
    expect(before.lastNotifiable).toMatchObject({ kind: "failed", id: failed.head })
    await drop(location, { queue: "lab", branch: "task/ended", by: "@dev/2" })
    expect(await chain.head()).toBe(failed.head)
    expect((await listRefs("refs/heads/task/ended", store)).size).toBe(0)
    expect(await readStatus(location, "lab", "task/ended")).toEqual(before)
  })

  // @failure delete-only drop loses a branch's newer, unkept commit (ADR-0018 / 25658).
  it("refuses an ended branch whose current head is not already kept by its chain", async () => {
    const { store, location } = remoteMemStore("yrd-event-drop-ended-advanced")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: "refs/heads/task/advanced" })
    const kept = (await branch.transact(async (map) => map.set("work", "one"), "work")).oid
    const chain = await openEvents({ ...store, ref: changesRef("lab", "task/advanced") })
    const opened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: kept, by: "@dev/2" })],
      { expect: null },
    )
    const failed = await chain.append(
      [changeInput("failed", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), reason: "check failed" })],
      { expect: opened.head },
    )
    const advanced = (await branch.transact(async (map) => map.set("work", "two"), "push after ending")).oid
    await expect(drop(location, { queue: "lab", branch: "task/advanced", by: "@dev/2" })).rejects.toThrow(
      new RegExp(`task/advanced.*${advanced}.*${kept}`),
    )
    expect(await branch.head()).toBe(advanced)
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
      commit: composed,
    })
    expect((await chain.events()).at(-1)).toMatchObject({ id: merging, type: "merging", links: [composed] })
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
      const reason = stuckReleaseReason(A, "raced repair")
      await writeQueueEvent(location, "lab", { type: "paused", by: "operator", reason, at: new Date() })
      await writeQueueEvent(location, "lab", { type: "resumed", by: "operator", reason, at: new Date() })
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
    await expect(
      writeQueueEvent(location, "lab", {
        type: "paused",
        reason: `yrd stuck release ${A} repair`,
        by: "operator",
        at: new Date("2026-09-22T14:00:10.000Z"),
      }),
    ).rejects.toThrow(/needs ops-cutover/)
    await expect(
      writeQueueEvent(location, "lab", {
        type: "resumed",
        reason: "retry a stuck change",
        by: "operator",
        at: new Date("2026-09-22T14:00:15.000Z"),
      }),
    ).rejects.toThrow(/needs a preceding pause/)
    const releaseReason = stuckReleaseReason(A, "repaired")
    const releasePause = await writeQueueEvent(location, "lab", {
      type: "paused",
      reason: releaseReason,
      by: "operator",
      at: new Date("2026-09-22T14:00:20.000Z"),
    })
    const halfRelease = await readEventQueue(location, "lab")
    expect(halfRelease.release).toMatchObject({ id: releasePause, reason: releaseReason })
    expect(eventPause(halfRelease)).toBeUndefined()
    const stuckResume = await writeQueueEvent(location, "lab", {
      type: "resumed",
      reason: releaseReason,
      by: "operator",
      at: new Date("2026-09-22T14:00:21.000Z"),
    })
    const beforeCutover = await readEventQueue(location, "lab")
    expect(beforeCutover.tip).toBe(stuckResume)
    expect(beforeCutover.release).toBeUndefined()
    expect(eventPause(beforeCutover)).toBeUndefined()
    await seedOpsCutover(location, "lab")
    await writeQueueEvent(location, "lab", {
      type: "paused",
      reason: "repair",
      by: "operator",
      at: new Date("2026-09-22T14:01:00.000Z"),
    })
    expect(eventPause(await readEventQueue(location, "lab"))?.reason).toBe("repair")
    expect(eventPause(await readEventQueue(location, "lab"))?.by).toBe("operator")
    await writeQueueEvent(location, "lab", {
      type: "resumed",
      reason: "repaired",
      by: "operator",
      at: new Date("2026-09-22T14:02:00.000Z"),
    })
    expect(eventPause(await readEventQueue(location, "lab"))).toBeUndefined()
    await expect(
      writeQueueEvent(location, "lab", {
        type: "resumed",
        reason: "again",
        by: "operator",
        at: new Date("2026-09-22T14:03:00.000Z"),
      }),
    ).rejects.toThrow(/queue is not paused/)
  })

  // @failure 25041: a caller could mistake any earlier resume for a release of the latest stuck change.
  it("exports the stuck Queue anchor read used by pre-cutover resume", async () => {
    const { store, location } = remoteMemStore("yrd-stuck-release-anchor")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const queueTip = await seedEventQueue(location, "lab", commit, new Date())
    const branch = "task/stuck-anchor"
    const opened = await (
      await openEvents({ ...store, ref: changesRef("lab", branch) })
    ).append([changeInput("opened", { queueTip, at: new Date(), commit, by: "@dev/2" })], { expect: null })
    if (opened.head === null) throw new Error("fixture opened event has no tip")
    const earlier = stuckReleaseReason(A, "earlier repair")
    await writeQueueEvent(location, "lab", { type: "paused", by: "@chief", reason: earlier, at: new Date() })
    await writeQueueEvent(location, "lab", { type: "resumed", by: "@chief", reason: earlier, at: new Date() })
    const stuck = await appendChangeEvent(location, "lab", branch, opened.head, {
      type: "stuck",
      at: new Date(),
      reason: "repair needed",
    })
    const history = (await readEventQueueWithChanges(location, "lab")).histories.get(branch)
    expect(await queueResumedAfter(location, "lab", branch, history)).toBe(false)
    const reason = stuckReleaseReason(stuck, "repaired")
    await writeQueueEvent(location, "lab", { type: "paused", by: "@chief", reason, at: new Date() })
    expect(await queueResumedAfter(location, "lab", branch, history)).toBe(false)
    await writeQueueEvent(location, "lab", { type: "resumed", by: "@chief", reason, at: new Date() })
    expect(await queueResumedAfter(location, "lab", branch, history)).toBe(true)
  })

  it("refuses ops cutover while a stuck release is unfinished", async () => {
    const { store, location } = remoteMemStore("yrd-unfinished-release-cutover")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date())
    await writeQueueEvent(location, "lab", {
      type: "paused",
      by: "@chief",
      reason: stuckReleaseReason(A, "repair"),
      at: new Date(),
    })
    await seedOpsCutover(location, "lab")
    await expect(readEventQueue(location, "lab")).rejects.toThrow(/cuts over during unfinished stuck release/)
  })

  it("starts a migrated queue paused on its created event and can resume normally", async () => {
    const { store, location } = remoteMemStore("yrd-event-start-paused")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const at = new Date("2026-09-22T14:00:00.000Z")
    const staged = await (
      await openEvents({ ...store, ref: queueRef("lab"), writer: "@dev/2" })
    ).stage(
      [
        {
          type: "created",
          props: [
            ["Commit", commit],
            ["Time", at.toISOString()],
            ["Start-Paused", "migration cutover"],
          ],
          keeps: [commit],
        },
      ],
      { expect: null },
    )
    await staged.publish()
    const created = staged.events[0]?.id
    if (created === undefined) throw new Error("fixture created event was not staged")
    const queue = await readEventQueue(location, "lab")
    expect(queue.pause).toEqual({ id: created, at, reason: "migration cutover", by: "@dev/2", cause: "operator" })
    await seedOpsCutover(location, "lab", {
      pause: { kind: "paused", sha: created, at, reason: "migration cutover", by: "@dev/2", cause: "operator" },
      overrides: [],
    })
    await writeQueueEvent(location, "lab", {
      type: "resumed",
      reason: "migration verified",
      by: "operator",
      at: new Date("2026-09-22T14:01:00.000Z"),
    })
    expect(eventPause(await readEventQueue(location, "lab"))).toBeUndefined()
  })

  /** @failure The created event loses the maintenance cause when legacy pause authority is deleted.
   * @level l1 @consumer migrated event submit and ops cutover
   */
  it("preserves a maintenance cause on a created event and rejects an unknown one", async () => {
    const at = new Date("2026-09-22T14:00:00.000Z")
    for (const [cause, accepted] of [
      ["maintenance", true],
      ["wedged", false],
    ] as const) {
      const { store, location } = remoteMemStore(`yrd-created-cause-${cause}`)
      const target = await open({ ...store, ref: "refs/heads/lab" })
      const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
      const staging = (await openEvents({ ...store, ref: queueRef("lab"), writer: "@chief" })).stage(
        [
          {
            type: "created",
            props: [
              ["Commit", commit],
              ["Time", at.toISOString()],
              ["Start-Paused", "25041 lab"],
              ["Pause-Cause", cause],
            ],
            keeps: [commit],
          },
        ],
        { expect: null },
      )
      if (accepted) {
        await (await staging).publish()
        expect(eventPause(await readEventQueue(location, "lab"))).toMatchObject({
          cause: "maintenance",
          by: "@chief",
          reason: "25041 lab",
          at,
        })
      } else {
        await (await staging).publish()
        await expect(readEventQueue(location, "lab")).rejects.toThrow("unreadable Pause-Cause: wedged")
      }
    }
  })

  /** @failure An event submit's stale queue-tip observation can publish beside a new maintenance pause.
   * @level l1 @consumer the event-format atomic submit lease
   */
  it("rejects an unchanged queue-tip lease when maintenance lands before the submit push", async () => {
    const { store, location, beforeNextPublish } = remoteMemStore("yrd-event-intake-race")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    await seedOpsCutover(location, "lab")
    const observed = await readEventQueue(location, "lab")
    const author = await open({ ...store, ref: "refs/heads/author" })
    const head = (await author.transact(async (map) => map.set("work.txt", "one"), "work")).oid
    const changeRef = changesRef("lab", "task/fenced")
    beforeNextPublish(async () => {
      await writeQueueEvent(location, "lab", {
        type: "paused",
        cause: "maintenance",
        by: "@chief",
        reason: "25041 lab",
        at: new Date(),
      })
    })
    await expect(
      (await openEvents({ ...store, ref: changeRef, writer: "@dev/2" })).transact(
        () => [changeInput("opened", { queueTip: observed.tip, at: new Date(), commit: head, by: "@dev/2" })],
        "submit task/fenced",
        {
          also: [
            { ref: "refs/heads/task/fenced", expect: null, oid: head },
            { ref: queueRef("lab"), expect: observed.tip, oid: observed.tip },
          ],
        },
      ),
    ).rejects.toBeInstanceOf(Conflict)
    expect(await (await openEvents({ ...store, ref: changeRef })).head()).toBeNull()
    expect((await listRefs("refs/heads/task/fenced", store)).size).toBe(0)
    expect(eventPause(await readEventQueue(location, "lab"))).toMatchObject({ cause: "maintenance", by: "@chief" })
  })

  it("keeps the complete override table on each ops event and refuses a missing snapshot", async () => {
    const { store, location } = remoteMemStore("yrd-event-ops-override")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    await seedOpsCutover(location, "lab")
    const actor = { by: "operator", verified: true }
    const first = await writeQueueOverride(
      location,
      "lab",
      { kind: "off", check: "build", until: new Date("2026-09-22T15:00:00.000Z"), reason: "repair", actor },
      ["build"],
      new Date("2026-09-22T14:01:00.000Z"),
    )
    expect(first.kind).toBe("set")
    expect(first.record.entries).toMatchObject([{ check: "build", record: first.record.sha, verified: true }])
    const second = await writeQueueOverride(
      location,
      "lab",
      { kind: "off", check: "build", until: new Date("2026-09-22T16:00:00.000Z"), reason: "more repair", actor },
      ["build"],
      new Date("2026-09-22T14:02:00.000Z"),
    )
    expect(second.kind).toBe("replaced")
    expect(second.replaced?.record).toBe(first.record.sha)
    const cleared = await writeQueueOverride(
      location,
      "lab",
      { kind: "clear", check: "build", reason: "fixed", actor },
      ["build"],
      new Date("2026-09-22T14:03:00.000Z"),
    )
    expect(cleared.kind).toBe("clear")
    expect((await readEventQueue(location, "lab")).ops?.overrides).toEqual([])
    const queue = await readEventQueue(location, "lab")
    await (
      await openEvents({ ...store, ref: queueRef("lab"), writer: "operator" })
    ).append(
      [
        {
          type: "override-set",
          props: [
            ["Queue", queue.tip],
            ["Time", "2026-09-22T14:04:00.000Z"],
            ["Check", "build"],
            ["Reason", "bad"],
          ],
        },
      ],
      { expect: queue.tip },
    )
    await expect(readEventQueue(location, "lab")).rejects.toThrow(/exactly one complete Ops: snapshot/)
  })

  it("records one reminder and one expiration on the queue event ref", async () => {
    const { store, location } = remoteMemStore("yrd-event-ops-clock")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    await seedOpsCutover(location, "lab")
    await writeQueueOverride(
      location,
      "lab",
      {
        kind: "off",
        check: "build",
        until: new Date("2026-09-22T15:00:00.000Z"),
        reason: "repair",
        actor: { by: "operator", verified: true },
      },
      ["build"],
      new Date("2026-09-22T14:00:40.000Z"),
    )
    const reminded = await expireQueueOverrides(location, "lab", Date.parse("2026-09-22T14:31:00.000Z"), "yrd")
    expect(reminded.reminded.map((entry) => entry.check)).toEqual(["build"])
    expect(reminded.expired).toEqual([])
    expect(
      (await expireQueueOverrides(location, "lab", Date.parse("2026-09-22T14:32:00.000Z"), "yrd")).reminded,
    ).toEqual([])
    const expired = await expireQueueOverrides(location, "lab", Date.parse("2026-09-22T15:01:00.000Z"), "yrd")
    expect(expired.expired.map((entry) => entry.check)).toEqual(["build"])
    expect(expired.table.entries[0]?.state).toBe("expired")
    expect(
      (await expireQueueOverrides(location, "lab", Date.parse("2026-09-22T15:02:00.000Z"), "yrd")).expired,
    ).toEqual([])
  })

  it("retains one direct landing and its settled notice on the queue chain", async () => {
    const { store, location } = remoteMemStore("yrd-event-direct-notice")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const observed = await writeQueueEvent(location, "lab", {
      type: "observed",
      commit,
      branch: "task/direct",
      by: "yrd-run",
      at: new Date("2026-09-22T14:01:00.000Z"),
    })
    expect((await readEventQueue(location, "lab")).observed[commit]).toEqual({ id: observed, branch: "task/direct" })
    expect(
      await writeQueueEvent(location, "lab", {
        type: "observed",
        commit,
        branch: "task/direct",
        by: "yrd-run",
        at: new Date("2026-09-22T14:02:00.000Z"),
      }),
    ).toBe(observed)
    const key = `${observed}:operator`
    const notified = await writeQueueEvent(location, "lab", {
      type: "notified",
      by: "yrd-run",
      at: new Date("2026-09-22T14:03:00.000Z"),
      notice: { for: observed, to: "operator", key, result: "delivered" },
    })
    expect((await readEventQueue(location, "lab")).notices[key]).toMatchObject({
      id: notified,
      for: observed,
      result: "delivered",
    })
    expect(
      await writeQueueEvent(location, "lab", {
        type: "notified",
        by: "yrd-run",
        at: new Date("2026-09-22T14:04:00.000Z"),
        notice: { for: observed, to: "operator", key, result: "delivered" },
      }),
    ).toBe(notified)
    await expect(
      writeQueueEvent(location, "lab", {
        type: "notified",
        by: "yrd-run",
        at: new Date("2026-09-22T14:05:00.000Z"),
        notice: { for: "f".repeat(40), to: "other", key: "bad", result: "delivered" },
      }),
    ).rejects.toThrow(/observed/)
    await expect(
      writeQueueEvent(location, "lab", {
        type: "observed",
        commit: B,
        by: "intruder",
        at: new Date("2026-09-22T14:06:00.000Z"),
      }),
    ).rejects.toThrow(/writer yrd-run/)
    const events = await (await openEvents({ ...location, ref: queueRef("lab") })).events()
    expect(events.map((event) => event.type)).toEqual(["created", "observed", "notified"])
    expect(events[1]?.links).toEqual([commit])
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
    expect(await listChangeHistories(first.location, "lab", { knownQueue: queue })).toEqual({
      histories: new Map(),
      invalid: new Map(),
    })
    await expect(listChangeHistories(second.location, "lab", { knownQueue: queue })).rejects.toThrow(
      /validated queue.*same location/,
    )
    await expect(listChangeHistories(first.location, "other", { knownQueue: queue })).rejects.toThrow(
      /validated queue.*same location/,
    )
    expect(await listChangeHistories(first.location, "lab")).toEqual({ histories: new Map(), invalid: new Map() })
  })

  it("reads the queue and change histories together with the same projection", async () => {
    const { store, location } = remoteMemStore("yrd-concurrent-list")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const queueTip = await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await openEvents({ ...store, ref: changesRef("lab", "task/42") })
    await branch.append([changeInput("opened", { queueTip, at: new Date(), commit, by: "@dev/2" })], {
      expect: null,
    })
    const legacyPause = await openEvents({ ...store, ref: pauseRef("lab") })
    await legacyPause.append([input("paused")], { expect: null })
    const { queue, histories, invalid } = await readEventQueueWithChanges(location, "lab")
    expect(queue).toEqual(await readEventQueue(location, "lab"))
    expect({ histories, invalid }).toEqual(await listChangeHistories(location, "lab", { knownQueue: queue }))
    expect([...histories.keys()]).toEqual(["task/42"])
  })

  // @failure one malformed branch chain blinded every healthy branch in the queue (25658).
  it("projects readable no-opened history and isolates an unfoldable chain beside a healthy one", async () => {
    const { store, location } = remoteMemStore("yrd-event-mixed-history")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const head = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const queueTip = await seedEventQueue(location, "lab", head, new Date("2026-09-22T14:00:00.000Z"))
    const at = new Date("2026-09-22T14:01:00.000Z")
    for (const [branch, input] of [
      ["task/healthy", changeInput("opened", { queueTip, at, commit: head, by: "@dev/2" })],
      ["task/old-drop", changeInput("cancelled", { queueTip, at, commit: head, by: "@dev/2", reason: "dropped" })],
      ["task/broken", changeInput("failed", { queueTip, at, reason: "no opened event" })],
    ] as const) {
      await (await openEvents({ ...store, ref: changesRef("lab", branch) })).append([input], { expect: null })
    }
    const { histories, invalid } = await readEventQueueWithChanges(location, "lab")
    expect([...histories.keys()]).toEqual(
      ["task/broken", "task/healthy", "task/old-drop"].filter((branch) => branch !== "task/broken"),
    )
    expect(invalid.get("task/broken")).toMatchObject({
      ref: changesRef("lab", "task/broken"),
      error: expect.stringContaining("needs an open change"),
    })
    const oldDrop = histories.get("task/old-drop")
    expect(oldDrop?.state).toMatchObject({
      status: "cancelled",
      diagnostic: expect.stringContaining("no opened event"),
    })
    const segments = enumerateChangeSegments(oldDrop?.events ?? [], changesRef("lab", "task/old-drop"), store.repo)
    expect(segments).toHaveLength(1)
    expect(
      eventListRows(new Map([["task/old-drop", segments.map((segment) => segment.state)]]), []).table,
    ).toMatchObject([{ branch: "task/old-drop", state: "cancelled", head }])
  })

  // @failure 25667: a future event kind made one branch invalid instead of preserving its known events and naming the kind.
  it("keeps known change events around unknown kinds and diagnoses only their branch", async () => {
    const { store, location } = remoteMemStore("yrd-unknown-change-kind")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const head = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const at = new Date("2026-09-22T14:01:00.000Z")
    const queueTip = await seedEventQueue(location, "lab", head, at)
    const changes = await openEvents({ ...store, ref: changesRef("lab", "task/future") })
    const written = await changes.append(
      [
        changeInput("opened", { queueTip, at, commit: head, by: "@dev/2" }),
        input("future-adopted"),
        changeInput("ignored", { queueTip, at, by: "@dev/2", reason: "manual" }),
        changeInput("unignored", { queueTip, at, by: "@dev/2" }),
        input("future-audit"),
      ],
      { expect: null },
    )
    const healthy = await openEvents({ ...store, ref: changesRef("lab", "task/healthy") })
    await healthy.append([changeInput("opened", { queueTip, at, commit: head, by: "@dev/2" })], { expect: null })

    const { histories, invalid } = await readEventQueueWithChanges(location, "lab")
    expect(invalid.size).toBe(0)
    const future = histories.get("task/future")
    expect(future?.state).toMatchObject({ status: "queued", commit: head, tip: written.events.at(-1)?.id })
    expect(future?.state.ignored).toBeUndefined()
    expect(future?.state.diagnostic).toContain("future-adopted")
    expect(future?.state.diagnostic).toContain("future-audit")
    expect(histories.get("task/healthy")?.state.diagnostic).toBeUndefined()
    expect(eventRows(new Map([...histories].map(([branch, history]) => [branch, history.state])))).toMatchObject([
      { branch: "task/future", state: "queued", diagnostic: expect.stringContaining("future-adopted") },
      { branch: "task/healthy", state: "queued" },
    ])
    expect((await readStatus(location, "lab", "task/future")).tip).toBe(written.events.at(-1)?.id)
    expect(
      (await readChangeEvents(location, "lab", "task/future", written.events.at(-1)?.id ?? "")).map(
        (item) => item.type,
      ),
    ).toEqual(["opened", "future-adopted", "ignored", "unignored", "future-audit"])
    expect(enumerateChangeSegments(future?.events ?? [], changesRef("lab", "task/future"), store.repo)).toMatchObject([
      { state: { status: "queued", diagnostic: expect.stringContaining("future-audit") } },
    ])
    expect(() => decide(future?.events ?? [], input("future-writer"))).toThrow(
      /cannot write unknown Yrd change event future-writer/,
    )

    // @failure 25667 CTO ruling: an ended segment's warning must not remain on a clean reopened live row.
    const closed = await changes.append(
      [changeInput("cancelled", { queueTip, at, commit: head, by: "@dev/2", reason: "dropped" })],
      { expect: written.events.at(-1)?.id ?? null },
    )
    await changes.append([changeInput("opened", { queueTip, at, commit: head, by: "@dev/2" })], {
      expect: closed.events[0]?.id ?? null,
    })
    const reopened = await readEventQueueWithChanges(location, "lab")
    expect(reopened.invalid.size).toBe(0)
    const current = reopened.histories.get("task/future")
    expect(current?.state.diagnostic).toBeUndefined()
    const segments = enumerateChangeSegments(current?.events ?? [], changesRef("lab", "task/future"), store.repo)
    expect(segments).toHaveLength(2)
    expect(segments[0]?.state.diagnostic).toContain("future-adopted")
    expect(segments[1]?.state.diagnostic).toBeUndefined()
    const document = eventListRows(new Map([["task/future", segments.map((segment) => segment.state)]]), [], {
      all: true,
    }).document
    expect(document.map((row) => row.diagnostic)).toEqual([undefined, expect.stringContaining("future-adopted")])
    const currentUnknown = await changes.append([input("future-current")], { expect: current?.state.tip ?? null })
    expect((await readStatus(location, "lab", "task/future")).diagnostic).toContain("future-current")
    expect((await readStatus(location, "lab", "task/future")).tip).toBe(currentUnknown.events[0]?.id)
  })

  // @failure 25647: adopting an older head after a resubmit can make that old head current or hide its ending.
  it("keeps an adopted old ending as a historical row without changing the live change", () => {
    const oldHead = "c".repeat(40)
    const oldRecord = "d".repeat(40)
    const currentHead = "e".repeat(40)
    const ref = changesRef("main", "task/24526")
    const opened = event(
      "opened",
      A,
      [
        ["Commit", currentHead],
        ["By", "@dev/12"],
        ["Time", "2026-09-24T20:00:00.000Z"],
      ],
      [currentHead],
    )
    const adopted = event(
      "adopted",
      B,
      [
        ["Time", "2026-09-25T02:00:00.000Z"],
        ["By", "yrd-adopter"],
        ["Adopted-Opened", "2026-09-24T12:00:00.000Z"],
        ["Adopted-Head", oldHead],
        ["Adopted-Status", "cancelled"],
        ["Adopted-Ended", "2026-09-24T12:30:00.000Z"],
        ["Adopted-Reason", "resubmitted"],
        ["Adopted-Submitter", "@dev/12"],
        ["Migrated-From", `refs/yrd/main/task/24526@${oldHead}@${oldRecord}`],
      ],
      [oldHead, oldRecord],
    )
    const events = [opened, adopted]
    const live = events.reduce(evolve, initial)
    expect(live).toMatchObject({
      status: "queued",
      commit: currentHead,
      since: new Date("2026-09-24T20:00:00.000Z"),
      tip: B,
    })
    expect(live.diagnostic).toBeUndefined()
    const segments = enumerateChangeSegments(events, ref, "fixture")
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({
      head: oldHead,
      state: { status: "cancelled", since: new Date("2026-09-24T12:00:00.000Z"), reason: "resubmitted" },
    })
    expect(segments[1]).toMatchObject({ head: currentHead, state: { status: "queued" } })
    const rows = eventListRows(new Map([["task/24526", segments.map((segment) => segment.state)]]), [], { all: true })
    expect(rows.table).toMatchObject([{ head: currentHead, state: "queued" }])
    expect(rows.document).toEqual(
      expect.arrayContaining([expect.objectContaining({ head: oldHead, state: "cancelled" })]),
    )
    expect(() => changeInput("adopted", { queueTip: A, at: new Date("2026-09-25T02:00:00.000Z") })).toThrow(
      /adoptedInput/,
    )
  })

  // @failure 25647: an adoption could lose source commits or invent decision evidence when written.
  it("constructs a kept adopted ending with one readable evidence grammar", () => {
    const source = { ref: `refs/yrd/main/task/24526@${B}`, oid: "d".repeat(40) }
    const details = {
      queueTip: A,
      at: new Date("2026-09-25T02:00:00.000Z"),
      head: B,
      opened: new Date("2026-09-24T12:00:00.000Z"),
      status: "merged" as const,
      ended: new Date("2026-09-24T12:30:00.000Z"),
      submitter: "@dev/12",
      issue: "24526",
      merge: "e".repeat(40),
      base: "f".repeat(40),
      config: "1".repeat(40),
      checks: ["test exit=0 ms=42 log=/tmp/real-old-log"],
      sources: [source],
      verifying: new Date("2026-09-24T12:10:00.000Z"),
    }
    const input = adoptedInput(details)
    expect(input.keeps).toEqual([B, source.oid, details.merge])
    expect(input.props).toEqual(
      expect.arrayContaining([
        ["By", "yrd-adopter"],
        ["Time", details.at.toISOString()],
        ["Adopted-Opened", details.opened.toISOString()],
        ["Adopted-Ended", details.ended.toISOString()],
        ["Adopted-Base", details.base],
        ["Adopted-Config", details.config],
        ["Check", details.checks[0]],
        ["Migrated-From", `${source.ref}@${source.oid}`],
      ]),
    )
    const reading = adoptedChange(event("adopted", "2".repeat(40), input.props, [...(input.keeps ?? [])]))
    expect(reading).toMatchObject({
      head: B,
      sources: [source],
      state: {
        status: "merged",
        adoptedMerge: details.merge,
        adoptedBase: details.base,
        adoptedConfig: details.config,
        adoptedChecks: details.checks,
        adoptedPhases: { verifying: details.verifying },
      },
    })
    expect(() => adoptedInput({ ...details, status: "queued" as never })).toThrow(/Adopted-Status/)
    expect(() => adoptedInput({ ...details, ended: undefined as never })).toThrow(/Adopted-Ended/)
    expect(() => adoptedInput({ ...details, sources: [] })).toThrow(/Migrated-From/)
    expect(() =>
      adoptedInput({ ...details, sources: [{ ref: `refs/yrd/main/task/24526@${A}`, oid: source.oid }] }),
    ).toThrow(/Migrated-From/)
  })

  // @failure 25647: old Opened: values could reorder event-chain history during adoption.
  it("keeps adoption event order even when old Opened times run backwards", () => {
    const ref = changesRef("main", "task/reused")
    const current = event("opened", A, [["Commit", B]], [B])
    const adopted = (id: string, head: string, opened: string, record: string) =>
      event(
        "adopted",
        id,
        [
          ["By", "yrd-adopter"],
          ["Adopted-Head", head],
          ["Adopted-Opened", opened],
          ["Adopted-Status", "cancelled"],
          ["Adopted-Ended", "2026-09-24T13:00:00.000Z"],
          ["Adopted-Reason", "resubmitted"],
          ["Adopted-Submitter", "@dev/12"],
          ["Migrated-From", `refs/yrd/main/task/reused@${head}@${record}`],
        ],
        [head, record],
      )
    const events = [
      current,
      adopted("1".repeat(40), "c".repeat(40), "2026-09-24T12:00:00.000Z", "e".repeat(40)),
      adopted("2".repeat(40), "d".repeat(40), "2026-09-23T12:00:00.000Z", "f".repeat(40)),
    ]
    const segments = enumerateChangeSegments(events, ref, "fixture")
    expect(segments.map(({ opened }) => opened)).toEqual(["1".repeat(40), "2".repeat(40), A])
    expect(segments.map(({ state }) => state.since)).toEqual([
      new Date("2026-09-24T12:00:00.000Z"),
      new Date("2026-09-23T12:00:00.000Z"),
      new Date("2026-09-22T14:00:00.000Z"),
    ])
  })

  // @failure 25647: an adopted old merge can disappear from listing, stats and direct-merge accounting.
  it("projects an adopted merged ending with its retained merge and missing phase evidence", () => {
    const currentHead = "e".repeat(40)
    const oldHead = "c".repeat(40)
    const oldRecord = "d".repeat(40)
    const merge = "f".repeat(40)
    const ref = changesRef("main", "task/old-merge")
    const events = [
      event(
        "opened",
        A,
        [
          ["Commit", currentHead],
          ["By", "@dev/12"],
        ],
        [currentHead],
      ),
      event(
        "adopted",
        B,
        [
          ["By", "yrd-adopter"],
          ["Adopted-Opened", "2026-09-23T12:00:00.000Z"],
          ["Adopted-Head", oldHead],
          ["Adopted-Status", "merged"],
          ["Adopted-Ended", "2026-09-24T12:30:00.000Z"],
          ["Adopted-Submitter", "@dev/12"],
          ["Adopted-Merge", merge],
          ["Migrated-From", `refs/yrd/main/task/old-merge@${oldHead}@${oldRecord}`],
        ],
        [oldHead, oldRecord, merge],
      ),
    ]
    const segments = enumerateChangeSegments(events, ref, "fixture")
    expect(segments.map((segment) => segment.head)).toEqual([oldHead, currentHead])
    const rows = eventListRows(new Map([["task/old-merge", segments.map((segment) => segment.state)]]), [], {
      all: true,
    })
    expect(rows.table).toMatchObject([{ head: currentHead, state: "queued" }])
    expect(rows.document).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ head: oldHead, state: "merged", merge, adoptedPhaseMissing: true }),
      ]),
    )
    expect([
      ...mergedHistoryCommits(new Map([["task/old-merge", { state: segments.at(-1)!.state, events }]])),
    ]).toContain(merge)
  })

  it("rejects an invalid queue chain through the combined read", async () => {
    const { store, location } = remoteMemStore("yrd-invalid-concurrent-list")
    const branch = await openEvents({ ...store, ref: queueRef("lab") })
    await branch.append([input("paused")], { expect: null })
    await expect(readEventQueueWithChanges(location, "lab")).rejects.toThrow(/refs\/yrd\/lab\/queue.*must be created/)
  })

  it("rejects a queue chain beyond the complete-read limit through the combined read", async () => {
    const { store, location } = remoteMemStore("yrd-long-concurrent-list")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const queueTip = await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await openEvents({ ...store, ref: queueRef("lab") })
    await branch.append(
      Array.from({ length: 1024 }, () => input("resumed")),
      { expect: queueTip },
    )
    await expect(readEventQueueWithChanges(location, "lab")).rejects.toThrow(
      /refs\/yrd\/lab\/queue.*exceeds 1024 events/,
    )
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
        ...(type === "verifying" || type === "merging" ? { commit: base } : {}),
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
