// @failure an event queue can show a stored status, accept a deciding event after an ending,
// or leave two changes open on one branch after resubmission.
// @level l1
// @consumer yrd list, submit and the queue runner on ADR-0016 event queues

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { Event, EventInput } from "gitomic/events"
import { listRefs, openEvents } from "gitomic/events"
import { createMemBackend } from "gitomic/mem"
import { Conflict, open, PublicationRejected } from "gitomic"
import type { GitomicBackend, RefUpdate } from "gitomic"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { outsideRepositoryRoot } from "../../../tests/support/outside-repository.ts"
import { retireOriginBranch } from "../src/origin-branch-retirement.ts"
import { transientPush5xxOf, transientPushRetry } from "../src/transient-push.ts"
import { EventRefsAcquireExhausted, readEventChain, readEventChains } from "../src/event-read.ts"
import { eventListRows, eventRows } from "../src/event-table.ts"
import { classifyQueueRef, pauseRef, runIndexRef } from "../src/refs.ts"
import { activateRunIndex, lookupRunIndex, queueReadWithRunIndex } from "../src/run-index.ts"
import { encodeOps, type OpsState } from "../src/ops-state.ts"
import { queueResumedAfter } from "../src/index.ts"
import {
  CHANGE_EVENT_TYPES,
  QUEUE_RUN_WRITER,
  adoptedChange,
  archiveQueue,
  appendChangeEvent,
  appendNumberedChangeEvent,
  changeInput,
  changesRef,
  decide,
  enumerateChangeSegments,
  expireQueueOverrides,
  drop,
  evolve,
  initial,
  listChangeHistories,
  listChanges,
  mergedHistoryCommits,
  queueFormat,
  queueRef,
  project,
  readChangeEvents,
  readBranchHistory,
  readEventOps,
  readEventOpsWithRefs,
  readEventQueue,
  readEventQueueWithChain,
  readEventQueueWithChanges,
  readStatus,
  setBranchIgnored,
  writeQueueEvent,
  writeQueueOverride,
} from "../src/events.ts"

const A = "a".repeat(40)
const B = "b".repeat(40)
const MERGED_EVENT = "c".repeat(40)
const EFFECT_EVENT = "d".repeat(40)
const ISSUE_EFFECT = {
  kind: "issue-effect-v1",
  mergedEvent: MERGED_EVENT,
  mergeSha: A,
  mergeCommitterTime: "2026-09-22T13:59:00.000Z",
  verb: "close",
  semanticEnding: "completed",
  issueKey: "wk/issue/314",
  providerId: "yrd1-93f1c4a38c9fddde33e2db50dd48bb4b93a883296ea4a1302871f51ad5b149fa",
  declaration: { path: "issues.yml", blob: B },
} as const

function changeChain(...events: Event[]): Event[] {
  return events.map((item, index): Event => {
    const previous = events[index - 1]
    return {
      ...item,
      parent: previous?.id ?? null,
      props: item.props.map(([key, value]): [string, string] =>
        key === "Queue" && previous !== undefined ? [key, previous.id] : [key, value],
      ),
    }
  })
}

function issueEffectEvent(effect: Readonly<Record<string, unknown>>, id = EFFECT_EVENT): Event {
  return { ...event("notified", id, [["Issue-Effect", JSON.stringify(effect)]], [A]), writer: QUEUE_RUN_WRITER }
}

function remoteMemStore(repo: string) {
  const backend = createMemBackend()
  const localRefs = backend.listRefs
  const localPublish = backend.publish
  if (localRefs === undefined || localPublish === undefined) throw new Error("mem backend lacks event ref operations")
  let beforePublish: (() => Promise<void>) | undefined
  // A hook that runs AFTER the ref actually moves, so a test can land a write and
  // THEN raise the remote's 5xx — the ambiguous case (28805) the landed probe exists for.
  let afterPublish: ((updates: readonly RefUpdate[]) => Promise<void>) | undefined
  const proxy: GitomicBackend = {
    ...backend,
    listRefs: (name, prefix) => localRefs(name, prefix),
    publish: async (name, updates) => {
      const hook = beforePublish
      beforePublish = undefined
      if (hook !== undefined) await hook()
      const published = await localPublish(name, updates)
      const landed = afterPublish
      afterPublish = undefined
      if (landed !== undefined) await landed(updates)
      return published
    },
    fetchRefs: async (name, refs, _remote, options) => {
      if (typeof refs === "string") return localRefs(name, refs)
      const found = new Map<string, string>()
      for (const ref of refs) {
        const oid = (await localRefs(name, ref)).get(ref)
        if (oid === undefined) {
          if (options?.absent === "omit") continue
          throw new Error(`missing fixture ref ${ref}`)
        }
        found.set(ref, oid)
      }
      return found
    },
    // This fixture's "remote" is the mem store itself and it keeps no gitomic private fetched
    // namespace, so it cannot prove any oid is already held: `undefined` is the contract's "fetch",
    // which is what every read here has always done (gitomic asks fetchedTip before skipping a fetch).
    fetchedTip: async () => undefined,
  }
  const store = { repo, backend: proxy }
  return {
    store,
    location: { ...store, remote: "origin", selection: gitIn(repo).selection },
    beforeNextPublish: (hook: () => Promise<void>) => (beforePublish = hook),
    afterNextPublish: (hook: (updates: readonly RefUpdate[]) => Promise<void>) => (afterPublish = hook),
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

/** Serialize historical pairs directly: the retired writer must never author them again. */
async function seedHistoricalRelease(
  location: Parameters<typeof readEventQueue>[0],
  queue: string,
  type: "paused" | "resumed",
  reason: string,
): Promise<string> {
  const previous = await readEventQueue(location, queue)
  const result = await (
    await openEvents({ ...location, ref: queueRef(queue), writer: "@chief" })
  ).append(
    [
      {
        type,
        props: [
          ["Queue", previous.tip],
          ["Time", new Date().toISOString()],
          ["Reason", reason],
        ],
      },
    ],
    { expect: previous.tip },
  )
  const id = result.events[0]?.id
  if (id === undefined) throw new Error("fixture historical release event was not written")
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
    expect(runIndexRef("feature/main")).toBe("refs/yrd/feature%2Fmain/runs")
    expect(changesRef("feature/main", "task/42-one")).toBe("refs/yrd/feature%2Fmain/changes/task/42-one")
    expect(() => changesRef("main", "../escape")).toThrow(/branch/)
  })

  it("classifies each owned ref kind without treating an unknown or nested old name as a current reader", () => {
    const sha = "a".repeat(40)
    expect(classifyQueueRef("main", "refs/yrd/main/queue")).toBe("queue")
    expect(classifyQueueRef("main", "refs/yrd/main/runs")).toBe("runs")
    expect(classifyQueueRef("main", "refs/yrd/main/runner")).toBe("runner")
    expect(classifyQueueRef("main", "refs/yrd/main/pause")).toBe("pause")
    expect(classifyQueueRef("main", "refs/yrd/main/override")).toBe("override")
    expect(classifyQueueRef("main", "refs/yrd/main/changes/task/one")).toBe("changes")
    expect(classifyQueueRef("main", `refs/yrd/main/task/one@${sha}`)).toBe("change")
    expect(classifyQueueRef("main", "refs/yrd/main/unnamed")).toBeUndefined()
    expect(classifyQueueRef("main", "refs/yrd/other/queue")).toBeUndefined()
  })
})

describe("ADR-0028 run-index lookup", () => {
  async function fixtureCommit(
    location: ReturnType<typeof remoteMemStore>["location"],
  ): Promise<{ genesis: string; commit: string }> {
    const genesis = await location.backend.writeGenesis?.(location.repo)
    if (genesis === undefined) throw new Error("fixture lacks Gitomic genesis")
    const commit = await location.backend.writeCommit(location.repo, {
      parent: genesis,
      time: 1_790_510_400,
      changes: new Map([[".yrd.yml", "target: main\n"]]),
      message: "queue fixture",
      writer: "fixture",
      instance: "run-index-test",
      seq: 1,
    })
    return { genesis, commit }
  }

  it("refuses an existing queue whose index has not been explicitly activated (26193)", async () => {
    // A missing index on an existing queue must not silently reseed at one.
    const { location } = remoteMemStore("run-index-missing")
    const { commit } = await fixtureCommit(location)
    await seedEventQueue(location, "main", commit, new Date("2026-09-27T12:00:00Z"))
    await expect(lookupRunIndex(location, "main", 1)).rejects.toThrow(/E_RUN_INDEX_MISSING.*refs\/yrd\/main\/runs/u)
  })

  it("activates only an existing queue and refuses a second creation lease (26193)", async () => {
    const { location } = remoteMemStore("run-index-activation")
    await expect(activateRunIndex(location, "main", new Date("2026-09-27T12:00:00Z"))).rejects.toThrow(
      /refs\/yrd\/main\/queue.*absent/u,
    )
    const { commit } = await fixtureCommit(location)
    await seedEventQueue(location, "main", commit, new Date("2026-09-27T12:00:00Z"))
    const tip = await activateRunIndex(location, "main", new Date("2026-09-27T12:01:00Z"))
    expect(tip).toMatch(/^[0-9a-f]{40}$/u)
    expect(await lookupRunIndex(location, "main", 1)).toEqual({ kind: "unknown", number: 1, knownThrough: 0 })
    await expect(activateRunIndex(location, "main", new Date("2026-09-27T12:02:00Z"))).rejects.toThrow(
      /refs\/yrd\/main\/runs.*already exists/u,
    )
  })

  it("publishes one index when two activators race, naming the winning tip in the refusal (26193)", async () => {
    // The sequential duplicate test cannot prove the absent-ref lease survives two simultaneous reads.
    const { location, beforeNextPublish } = remoteMemStore("run-index-activation-race")
    const { commit } = await fixtureCommit(location)
    await seedEventQueue(location, "main", commit, new Date("2026-09-27T12:00:00Z"))
    let winner: string | undefined
    beforeNextPublish(async () => {
      winner = await activateRunIndex(location, "main", new Date("2026-09-27T12:01:01Z"))
    })

    let refusal: unknown
    try {
      await activateRunIndex(location, "main", new Date("2026-09-27T12:01:00Z"))
    } catch (error) {
      refusal = error
    }
    if (winner === undefined) throw new Error("racing activator did not publish")
    expect(String(refusal)).toContain(`${runIndexRef("main")} is at ${winner}, not absent`)
    const refs = await location.backend.listRefs?.(location.repo, runIndexRef("main"))
    expect(refs?.size).toBe(1)
    expect(refs?.get(runIndexRef("main"))).toBe(winner)
  })

  it("distinguishes an unknown number from a stored run record without scanning history (26193)", async () => {
    const { location } = remoteMemStore("run-index-lookup")
    const { genesis, commit } = await fixtureCommit(location)
    if (location.backend.publish === undefined) throw new Error("fixture lacks Gitomic publish")
    const firstQueueTip = await seedEventQueue(location, "main", commit, new Date("2026-09-27T12:00:00Z"))
    const indexRef = runIndexRef("main")
    await location.backend.publish(location.repo, [{ ref: indexRef, expect: "0".repeat(40), oid: genesis }], "origin")
    await expect(lookupRunIndex(location, "main", 1)).rejects.toThrow(/E_RUN_INDEX_CORRUPT.*next/u)
    const index = await open({ repo: location.repo, backend: location.backend, ref: indexRef, writer: "yrd" })
    await index.transact(async (map) => {
      map.set("next", "2")
      map.set(
        "by-number/0/1",
        JSON.stringify({
          id: "opaque-run-id",
          startedAt: "2026-09-27T12:00:00Z",
          host: "hh",
          actor: "yrd",
          firstQueueTip,
        }),
      )
    }, "record first run")
    expect(await lookupRunIndex(location, "main", 1)).toMatchObject({
      kind: "known",
      number: 1,
      record: { id: "opaque-run-id", firstQueueTip },
    })
    expect(await lookupRunIndex(location, "main", 2)).toEqual({ kind: "unknown", number: 2, knownThrough: 1 })
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

  it("accepts a reverted-paths admission-warning and refuses an unknown Warning-Kind (27363)", () => {
    const opened = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const reverted = evolve(
      opened,
      event(
        "admission-warning",
        B,
        [
          ["Commit", A],
          ["Reason", "km: 9 reverted path(s) (coverage complete)"],
          ["Warning-Kind", "reverted-paths"],
        ],
        [A],
      ),
    )
    // #28195: the revert finding is carried STRUCTURED — kind, event, reason — and stays out of the
    // folded `diagnostic` string, so a listing summarises it from the reason’s own payload instead of
    // re-reading ~100 KB of gap prose per row. The old-shape record below still folds as a diagnostic.
    expect(reverted.diagnostic).toBeUndefined()
    expect(reverted.admissionWarning).toMatchObject({
      kind: "reverted-paths",
      event: B,
      reason: "km: 9 reverted path(s) (coverage complete)",
    })

    // An unknown kind is still refused BY NAME (a throw, not a diagnostic).
    expect(() =>
      evolve(
        opened,
        event(
          "admission-warning",
          B,
          [
            ["Commit", A],
            ["Reason", "x"],
            ["Warning-Kind", "banana"],
          ],
          [A],
        ),
      ),
    ).toThrow(/unknown Warning-Kind: banana/u)
  })

  it("keeps the approved change-event vocabulary exact", () => {
    expect(CHANGE_EVENT_TYPES).toEqual([
      "opened",
      "admission-warning",
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
      "archived",
      "retained",
    ])
  })

  /** @failure Retaining an extra head rewrites the factual merge, its clocks, or its metadata.
   * @level l0 @consumer merged-branch retirement and every event projection
   * Existing neutral-event cases cover notification and archive transfer, not extra-head custody.
   */
  it("30432: retained keeps an extra head while changing only the merged projection tip", () => {
    const history = [
      event(
        "opened",
        A,
        [
          ["Commit", A],
          ["Issue", "30432"],
          ["Component-Authors", JSON.stringify([{ path: "vendor/dep", branch: "task/dep", tip: B }])],
        ],
        [A],
      ),
      event(
        "merged",
        MERGED_EVENT,
        [
          ["Commit", A],
          ["Run", "retention-reader-fixture"],
          ["Gitlinks", JSON.stringify([{ path: "vendor/dep", target: A }])],
        ],
        [A],
      ),
      event("notified", EFFECT_EVENT, [
        ["For", MERGED_EVENT],
        ["To", "@dev/3"],
        ["Result", "delivered"],
        ["Key", `${MERGED_EVENT}:@dev/3`],
      ]),
    ]
    const before = history.reduce(evolve, initial)
    const retained = event(
      "retained",
      "e".repeat(40),
      [
        ["Commit", B],
        ["By", "@dev/3"],
        ["Reason", "keep the unlinked extra head before retirement"],
        ["Time", "2026-10-20T12:00:00.000Z"],
      ],
      [B],
    )
    expect(evolve(before, retained)).toEqual({ ...before, tip: retained.id })
    const write = changeInput("retained", {
      queueTip: A,
      at: new Date("2026-10-20T12:00:00.000Z"),
      commit: B,
      by: "@dev/3",
      reason: "keep the unlinked extra head before retirement",
    })
    expect(write.keeps).toEqual([B])
    expect(decide(history, write)).toEqual([write])
  })

  /** @failure A malformed retained record grants custody without a real parent or factual merge.
   * @level l0 @consumer retained-event construction and persisted history folding
   * Existing kept-commit rows do not require this event's actor/reason or validate its persisted OID.
   */
  it("30432: retained requires a merged ending, valid kept commit, actor and reason at both boundaries", () => {
    const opened = event("opened", A, [["Commit", A]], [A])
    const merged = [opened, event("merged", MERGED_EVENT, [["Commit", A]], [A])].reduce(evolve, initial)
    const details = {
      queueTip: A,
      at: new Date("2026-10-20T12:00:00.000Z"),
      commit: B,
      by: "@dev/3",
      reason: "keep extra head",
    }
    for (const [field, key, value] of [
      ["commit", "Commit", undefined],
      ["commit", "Commit", "not-an-oid"],
      ["by", "By", undefined],
      ["by", "By", " "],
      ["reason", "Reason", undefined],
      ["reason", "Reason", " "],
    ] as const) {
      expect(() => changeInput("retained", { ...details, [field]: value }), `${field}: ${String(value)}`).toThrow(key)
      const props: [string, string][] = [
        ["Commit", B],
        ["By", "@dev/3"],
        ["Reason", "keep extra head"],
      ]
      const malformed = props.filter(([name]) => name !== key)
      if (value !== undefined) malformed.push([key, value])
      expect(() =>
        evolve(
          merged,
          event("retained", EFFECT_EVENT, malformed, [value === undefined ? B : field === "commit" ? value : B]),
        ),
      ).toThrow(key)
    }
    const valid = changeInput("retained", details)
    expect(() => evolve(merged, event("retained", EFFECT_EVENT, valid.props, []))).toThrow(/keep Commit/u)
    for (const history of [
      [],
      [opened],
      [opened, event("failed", MERGED_EVENT)],
      [opened, event("cancelled", MERGED_EVENT, [["Reason", "resubmitted"]])],
    ]) {
      expect(() => decide(history, valid)).toThrow(/merged/u)
    }
  })

  /** @failure Invalid landing metadata grants false component retirement proof, or leaks into resubmission.
   * @level l0 @consumer yrd local component branch retirement
   */
  it("folds landing gitlinks, reads old events and clears pins on resubmission", () => {
    const opened = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const pins = [{ path: "vendor/child", target: B }]
    const landed = evolve(
      opened,
      event(
        "merged",
        B,
        [
          ["Commit", A],
          ["Gitlinks", JSON.stringify(pins)],
        ],
        [A],
      ),
    )
    expect(landed.landedGitlinks).toEqual(pins)
    expect(evolve(opened, event("merged", B, [["Commit", A]], [A])).landedGitlinks).toBeUndefined()
    expect(evolve(landed, event("opened", A, [["Commit", B]], [B])).landedGitlinks).toBeUndefined()
    for (const value of [
      "broken JSON",
      "{}",
      "null",
      JSON.stringify([{ path: "../child", target: B }]),
      JSON.stringify([{ path: "child", target: "invalid" }]),
      JSON.stringify([pins[0], pins[0]]),
    ]) {
      expect(() =>
        evolve(
          opened,
          event(
            "merged",
            B,
            [
              ["Commit", A],
              ["Gitlinks", value],
            ],
            [A],
          ),
        ),
      ).toThrow(/Gitlinks/)
    }
    expect(() =>
      evolve(
        opened,
        event(
          "merged",
          B,
          [
            ["Commit", A],
            ["Gitlinks", "[]"],
            ["Gitlinks", "[]"],
          ],
          [A],
        ),
      ),
    ).toThrow(/Gitlinks/)
    expect(() =>
      evolve(
        initial,
        event(
          "opened",
          A,
          [
            ["Commit", A],
            ["Gitlinks", "[]"],
          ],
          [A],
        ),
      ),
    ).toThrow(/Gitlinks/)
  })

  /** @failure An older pinned reader rejects the new optional author trailer or changes existing change facts.
   * @level l0 @consumer mixed-version Yrd readers during the component-retirement landing window
   * Existing landing-pin cases exercise known trailers, not an unknown optional opened trailer.
   */
  it("accepts optional component authors without changing the base opened fold", () => {
    const opened = event("opened", A, [["Commit", B]], [B])
    const attributed = {
      ...opened,
      props: [
        ...opened.props,
        [
          "Component-Authors",
          JSON.stringify([{ path: "vendor/child", branch: "topic/actual-author", tip: B }]),
        ] as const,
      ],
    }
    const { componentAuthors: _newFields, ...knownFields } = evolve(initial, attributed) as ReturnType<
      typeof evolve
    > & { componentAuthors?: unknown }
    expect(knownFields).toEqual(evolve(initial, opened))
  })

  /** @failure Resubmission inherits another submit's component author, or an ending loses its author evidence.
   * @level l0 @consumer component branch retirement after landing or release of a hold
   * The native landing test does not resubmit a branch or decode malformed persisted metadata.
   */
  it("retains component authors through an ending and clears them on resubmission", () => {
    const authors = [{ path: "vendor/child", branch: "topic/actual-author", tip: B }]
    const written = changeInput("opened", {
      queueTip: A,
      at: new Date("2026-09-22T14:00:00.000Z"),
      commit: B,
      by: "fixture",
      componentAuthors: authors,
    })
    const opened = evolve(initial, event("opened", A, written.props, [B]))
    expect(opened).toHaveProperty("componentAuthors", authors)
    const ended = evolve(opened, event("cancelled", B, [["Reason", "resubmitted"]]))
    expect(ended).toHaveProperty("componentAuthors", authors)
    expect(evolve(ended, event("opened", A, [["Commit", B]], [B]))).not.toHaveProperty("componentAuthors")
  })

  /** @failure Malformed persisted author metadata is accepted as deletion authority.
   * @level l0 @consumer readers of the optional Component-Authors trailer
   */
  it.each([
    "not-json",
    "null",
    JSON.stringify([{ path: "../child", branch: "topic/author", tip: B }]),
    JSON.stringify([{ path: "vendor/child", branch: "topic/author", tip: "short" }]),
    JSON.stringify([{ path: "vendor/child", branch: "../author", tip: B }]),
    JSON.stringify([{ path: "vendor/child", tip: B }]),
    JSON.stringify(Array(2).fill({ path: "vendor/child", branch: "topic/author", tip: B })),
  ])("refuses malformed component authors: %s", (value) => {
    expect(() =>
      evolve(
        initial,
        event(
          "opened",
          A,
          [
            ["Commit", B],
            ["Component-Authors", value],
          ],
          [B],
        ),
      ),
    ).toThrow(/Component-Authors/)
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

  it("keeps a typed issue effect neutral across a later branch reuse", () => {
    const opened = event("opened", A, [["Commit", A]], [A])
    const merged = event("merged", MERGED_EVENT, [["Commit", A]], [A])
    const effect = issueEffectEvent(ISSUE_EFFECT)
    const laterEffect = {
      ...effect,
      props: effect.props.map(([key, value]) =>
        key === "Time" ? ([key, "2026-09-22T14:01:00.000Z"] as [string, string]) : ([key, value] as [string, string]),
      ),
    }
    const original = changeChain(opened, merged)
    const withEffect = changeChain(opened, merged, laterEffect)
    const beforeEffect = project(original, "refs/yrd/q/changes/task/reused", "fixture")
    const afterEffect = project(withEffect, "refs/yrd/q/changes/task/reused", "fixture")

    expect(afterEffect).toMatchObject({
      status: beforeEffect.status,
      at: beforeEffect.at,
      endedAt: beforeEffect.endedAt,
      lastNotifiable: beforeEffect.lastNotifiable,
      ending: beforeEffect.ending,
      tip: EFFECT_EVENT,
    })
    expect(afterEffect.notices).toEqual(beforeEffect.notices)

    const reopened = event("opened", "e".repeat(40), [["Commit", B]], [B])
    const reused = project(
      changeChain(opened, merged, laterEffect, reopened),
      "refs/yrd/q/changes/task/reused",
      "fixture",
    )
    expect(reused).toMatchObject({ status: "queued", commit: B, tip: reopened.id })
  })

  it("allows an older validated effect while the reused branch is in merging", () => {
    const oldOpened = event("opened", A, [["Commit", A]], [A])
    const oldMerged = event("merged", MERGED_EVENT, [["Commit", A]], [A])
    const reopened = event("opened", "f".repeat(40), [["Commit", B]], [B])
    const verifying = event("verifying", "1".repeat(40), [["Commit", B]], [B])
    const checking = event("checking", "2".repeat(40))
    const merging = event("merging", "3".repeat(40), [["Commit", B]], [B])
    const effect = issueEffectEvent(ISSUE_EFFECT, "4".repeat(40))
    const laterEffect = {
      ...effect,
      props: effect.props.map(([key, value]) =>
        key === "Time" ? ([key, "2026-09-22T14:01:00.000Z"] as [string, string]) : ([key, value] as [string, string]),
      ),
    }
    const prefix = changeChain(oldOpened, oldMerged, reopened, verifying, checking, merging)
    const atMerging = project(prefix, "refs/yrd/q/changes/task/reused", "fixture")

    expect(atMerging.status).toBe("merging")
    expect(atMerging.at).toEqual(new Date("2026-09-22T14:00:00.000Z"))
    expect(atMerging.endedAt).toBeUndefined()
    expect(atMerging.lastNotifiable).toBeUndefined()
    const afterEffect = project(
      changeChain(oldOpened, oldMerged, reopened, verifying, checking, merging, laterEffect),
      "refs/yrd/q/changes/task/reused",
      "fixture",
    )
    expect(afterEffect.status).toBe(atMerging.status)
    expect(afterEffect.at).toEqual(atMerging.at)
    expect(afterEffect.endedAt).toEqual(atMerging.endedAt)
    expect(afterEffect.lastNotifiable).toEqual(atMerging.lastNotifiable)
    expect(afterEffect.candidate).toBe(atMerging.candidate)
    expect(afterEffect.tip).toBe(laterEffect.id)
  })

  it.each([
    ["missing", { mergedEvent: "f".repeat(40) }, "earlier merged event"],
    ["wrong kind", { mergedEvent: A }, "does not name an earlier merged event"],
    [
      "wrong sha",
      {
        mergeSha: B,
        providerId: "yrd1-ad2873d572ef06b4ec828dc845a0897912b5b47eb936cef79981e088f0529002",
      },
      "does not match merged event",
    ],
  ])("refuses an issue effect with a %s merge reference", (_name, override, message) => {
    const opened = event("opened", A, [["Commit", A]], [A])
    const merged = event("merged", MERGED_EVENT, [["Commit", A]], [A])
    const effect = issueEffectEvent({ ...ISSUE_EFFECT, ...override })
    expect(() => project(changeChain(opened, merged, effect), "refs/yrd/q/changes/task/bad-ref", "fixture")).toThrow(
      message,
    )
  })

  it("refuses a forward issue-effect merge reference", () => {
    const opened = event("opened", A, [["Commit", A]], [A])
    const effect = issueEffectEvent(ISSUE_EFFECT, "e".repeat(40))
    const merged = event("merged", MERGED_EVENT, [["Commit", A]], [A])
    expect(() =>
      project(changeChain(opened, effect, merged), "refs/yrd/q/changes/task/forward-ref", "fixture"),
    ).toThrow(/earlier merged event/u)
  })

  type ReaderRefusal = Readonly<{
    name: string
    legacyTrailer?: readonly [string, string]
    alter?: (raw: Record<string, unknown>) => Record<string, unknown>
    serialized?: string
    eventType?: string
    writer?: string
    expected: RegExp
  }>
  const readerRefusals: readonly ReaderRefusal[] = [
    { name: "Reason", legacyTrailer: ["Reason", "audit"], expected: /cannot carry Reason/u },
    { name: "For", legacyTrailer: ["For", A], expected: /cannot carry For/u },
    { name: "To", legacyTrailer: ["To", "recipient@example.invalid"], expected: /cannot carry To/u },
    { name: "Key", legacyTrailer: ["Key", "issue"], expected: /cannot carry Key/u },
    { name: "Result", legacyTrailer: ["Result", "delivered"], expected: /cannot carry Result/u },
    {
      name: "providerId mismatch",
      alter: (raw) => ({ ...raw, providerId: "yrd1-wrong" }),
      expected: /providerId must be/u,
    },
    { name: "non-object JSON value", serialized: "null", expected: /expected an object/u },
    {
      name: "unknown kind",
      alter: (raw) => ({ ...raw, kind: "issue-effect-v2" }),
      expected: /unknown kind/u,
    },
    {
      name: "malformed merged event id",
      alter: (raw) => ({ ...raw, mergedEvent: "not-an-oid" }),
      expected: /mergedEvent and mergeSha must be commit ids/u,
    },
    {
      name: "malformed merge SHA",
      alter: (raw) => ({ ...raw, mergeSha: "not-an-oid" }),
      expected: /mergedEvent and mergeSha must be commit ids/u,
    },
    {
      name: "unknown verb",
      alter: (raw) => ({ ...raw, verb: "resolve" }),
      expected: /verb must be close or comment/u,
    },
    {
      name: "non-string providerId",
      alter: (raw) => ({ ...raw, providerId: 12 }),
      expected: /providerId must be a string/u,
    },
    {
      name: "effect on wrong event type",
      eventType: "future-effect",
      expected: /belongs on notified/u,
    },
    { name: "malformed serialized JSON", serialized: "{", expected: /malformed Issue-Effect/u },
    {
      name: "non-canonical JSON",
      alter: (raw) => Object.fromEntries(Object.entries(raw).reverse()),
      expected: /must use canonical JSON/u,
    },
    { name: "extra field", alter: (raw) => ({ ...raw, extra: true }), expected: /unexpected fields/u },
    {
      name: "missing field",
      alter: (raw) => {
        const { declaration: _declaration, ...rest } = raw
        return rest
      },
      expected: /declaration must name its committed source/u,
    },
    {
      name: "wrong verb-ending pairing",
      alter: (raw) => ({ ...raw, verb: "comment" }),
      expected: /comment cannot carry semanticEnding/u,
    },
    {
      name: "close without semantic ending",
      alter: (raw) => {
        const { semanticEnding: _semanticEnding, ...rest } = raw
        return rest
      },
      expected: /close needs semanticEnding/u,
    },
    { name: "empty key", alter: (raw) => ({ ...raw, issueKey: " " }), expected: /issueKey must be nonempty/u },
    {
      name: "non-ISO time",
      alter: (raw) => ({ ...raw, mergeCommitterTime: "yesterday" }),
      expected: /mergeCommitterTime must be an ISO instant/u,
    },
    {
      name: "parseable but non-canonical ISO time",
      alter: (raw) => ({ ...raw, mergeCommitterTime: "2026-09-22T13:59:00Z" }),
      expected: /mergeCommitterTime must be an ISO instant/u,
    },
    { name: "wrong writer", writer: "yrd", expected: /needs writer/u },
  ]

  it.each(readerRefusals)(
    "reader refuses $name",
    ({ legacyTrailer, alter, serialized, eventType, writer, expected }) => {
      const opened = event("opened", A, [["Commit", A]], [A])
      const merged = event("merged", MERGED_EVENT, [["Commit", A]], [A])
      const effectValue = alter === undefined ? ISSUE_EFFECT : alter(ISSUE_EFFECT as unknown as Record<string, unknown>)
      const base = issueEffectEvent(effectValue)
      const effect = {
        ...base,
        ...(eventType === undefined ? {} : { type: eventType }),
        ...(writer === undefined ? {} : { writer }),
        props: [
          ...base.props.map(([key, value]): [string, string] =>
            key === "Issue-Effect" && serialized !== undefined ? [key, serialized] : [key, value],
          ),
          ...(legacyTrailer === undefined ? [] : [legacyTrailer]),
        ],
      }
      expect(() => project(changeChain(opened, merged, effect), "refs/yrd/q/changes/task/refusal", "fixture")).toThrow(
        expected,
      )
    },
  )

  it("validates issue-effect merge references when enumerating public change segments", () => {
    const opened = event("opened", A, [["Commit", A]], [A])
    const merged = event("merged", MERGED_EVENT, [["Commit", A]], [A])
    const effect = issueEffectEvent({ ...ISSUE_EFFECT, mergedEvent: "f".repeat(40) })

    expect(() =>
      enumerateChangeSegments(
        changeChain(opened, merged, effect),
        "refs/yrd/q/changes/task/segments-bad-ref",
        "fixture",
      ),
    ).toThrow(/earlier merged event/u)
  })

  it("refuses a duplicate issue-effect identity on one branch chain", () => {
    const opened = event("opened", A, [["Commit", A]], [A])
    const merged = event("merged", MERGED_EVENT, [["Commit", A]], [A])
    const first = issueEffectEvent(ISSUE_EFFECT)
    const second = issueEffectEvent(ISSUE_EFFECT, "e".repeat(40))
    expect(() =>
      project(changeChain(opened, merged, first, second), "refs/yrd/q/changes/task/duplicate-effect", "fixture"),
    ).toThrow(/duplicate issue effect/u)
  })

  it("serializes the typed issue effect on the existing notified event", () => {
    const written = changeInput("notified", {
      queueTip: A,
      at: new Date("2026-09-22T14:01:00.000Z"),
      issueEffect: ISSUE_EFFECT,
    })
    expect(written.props).toContainEqual(["Issue-Effect", JSON.stringify(ISSUE_EFFECT)])
    expect(written.props?.some(([key]) => ["For", "To", "Key", "Result"].includes(key))).toBe(false)
  })

  it("rejects a reason on an issue-effect notification", () => {
    expect(() =>
      changeInput("notified", {
        queueTip: A,
        at: new Date("2026-09-22T14:01:00.000Z"),
        issueEffect: ISSUE_EFFECT,
        reason: "audit",
      }),
    ).toThrow(/issue effect cannot carry Reason/u)
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

  // 30683 (b): the owner's drop of an advanced head records its tip, how many commits its target lacks, and that target.
  it("writes, folds and reads back an advanced drop's Tip:, Unique-Commits: and Target:", () => {
    const advanced = { tip: B, uniqueCommits: 2, target: { ref: "refs/heads/main", tip: "e".repeat(40) } }
    const details = {
      queueTip: A,
      at: new Date("2026-10-22T09:00:00.000Z"),
      commit: A,
      reason: "dropped",
      by: "@dev/7",
      content: "superseded by 30704",
      advanced,
    }
    const written = changeInput("cancelled", details)
    expect(written.keeps).toEqual([A, B])
    expect(written.content).toBe("superseded by 30704")
    const opened = evolve(initial, event("opened", "1".repeat(40), [["Commit", A]], [A]))
    const props = written.props ?? []
    const dropped = evolve(opened, event(written.type, "2".repeat(40), props, [...(written.keeps ?? [])]))
    expect(dropped).toMatchObject({ status: "cancelled", reason: "dropped", commit: A, advancedDrop: advanced })
    // A new change on the branch does not inherit it.
    expect(evolve(dropped, event("opened", "3".repeat(40), [["Commit", B]], [B])).advancedDrop).toBeUndefined()
    // The three trailers go together, on a dropped event that keeps both commits.
    const without = (key: string) => props.filter(([name]) => name !== key)
    expect(() => evolve(opened, event("cancelled", "4".repeat(40), without("Unique-Commits"), [A, B]))).toThrow(
      /advanced drop/,
    )
    expect(() => evolve(opened, event("cancelled", "4".repeat(40), props, [A]))).toThrow(/advanced drop/)
    // The owner's reason is the content, and only a dropped event carries the record.
    expect(() => changeInput("cancelled", { ...details, content: " " })).toThrow(/reason/)
    expect(() => changeInput("cancelled", { ...details, reason: "withdrawn" })).toThrow(/dropped/)
    expect(() => changeInput("cancelled", { ...details, advanced: { ...advanced, uniqueCommits: 0 } })).toThrow(
      /Unique-Commits/,
    )
  })

  // @failure a malformed drop event after a landing turns a merged change into cancelled (26223).
  it("refuses a dropped ending after merge without changing the merged projection", () => {
    const opened = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const merged = evolve(opened, event("merged", B, [["Commit", A]], [A]))
    expect(() =>
      evolve(
        merged,
        event(
          "cancelled",
          "c".repeat(40),
          [
            ["Reason", "dropped"],
            ["Commit", A],
          ],
          [A],
        ),
      ),
    ).toThrow(/cancelled.*follows merged/)
    expect(merged.status).toBe("merged")
  })
})

describe("the queue-format boundary", () => {
  /** @failure 27957: archive only old merged/cancelled chains, preserving protected states and neutral audit history.
   * @level l1 @consumer yrd queue archive dry-run and manual publication
   * Existing cold-reader fixtures move refs by hand and do not exercise eligibility or the production transfer.
   */
  it("archives only old safe endings with an exact audit and preserves every protected ref", async () => {
    const { store, location, beforeNextPublish } = remoteMemStore("yrd-archive-policy")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const head = (await target.transact(async (map) => map.set("work", "kept payload"), "work")).oid
    const at = new Date("2026-09-22T14:00:00.000Z")
    const now = new Date("2026-10-07T12:00:00.000Z")
    const queueTip = await seedEventQueue(location, "lab", head, at)
    const tips = new Map<string, string>()
    for (const state of [
      "merged",
      "cancelled",
      "failed",
      "queued",
      "verifying",
      "checking",
      "merging",
      "stuck",
      "ignored",
      "recent",
    ] as const) {
      const chain = await openEvents({ ...store, ref: changesRef("lab", `task/${state}`) })
      const inputs = [changeInput("opened", { queueTip, at, commit: head, by: "@dev/6" })]
      if (state === "checking" || state === "merging") {
        inputs.push(changeInput("verifying", { queueTip, at, commit: head }))
      }
      if (state === "merging") inputs.push(changeInput("checking", { queueTip, at }))
      if (state !== "queued") {
        inputs.push(
          changeInput(state === "recent" ? "merged" : state, {
            queueTip,
            at: state === "recent" ? now : at,
            commit: head,
            by: "@dev/6",
            reason: state === "cancelled" ? "withdrawn" : state,
          }),
        )
      }
      const result = await chain.append(inputs, { expect: null })
      if (result.head === null) throw new Error("fixture lost branch tip")
      tips.set(`task/${state}`, result.head)
    }
    const before = await listRefs("refs/", location)
    const request = { dryRun: true, at: now, by: "@dev/6" }
    const preview = await archiveQueue(location, "lab", request)
    expect(preview).toMatchObject({ examined: 10, protected: 7, recent: 1, archived: [] })
    expect(preview.candidates.map((row) => row.branch)).toEqual(["task/cancelled", "task/merged"])
    expect(await listRefs("refs/", location)).toEqual(before)
    // @failure 27957: an intervening late notice must lose the exact archive lease, never be dropped by a retry.
    // It changes the tip without changing endedAt, so the next explicit pass must still select the old ending.
    const cancelled = await readStatus(location, "lab", "task/cancelled")
    if (cancelled.tip === undefined || cancelled.ending === undefined) throw new Error("fixture lost cancelled ending")
    const cancelledTip = cancelled.tip
    const ending = cancelled.ending.id
    beforeNextPublish(async () => {
      await appendChangeEvent(location, "lab", "task/cancelled", cancelledTip, {
        type: "notified",
        at: now,
        notice: { for: ending, to: "operator", key: `${ending}:operator`, result: "delivered" },
      })
    })
    await expect(archiveQueue(location, "lab", { ...request, dryRun: false })).rejects.toBeInstanceOf(Conflict)
    expect((await listRefs("refs/yrd-archive/", location)).size).toBe(0)
    const notified = await readStatus(location, "lab", "task/cancelled")
    expect(notified).toMatchObject({ endedAt: at, ending: { id: ending } })
    if (notified.tip === undefined) throw new Error("fixture lost notified tip")
    tips.set("task/cancelled", notified.tip)
    const applied = await archiveQueue(location, "lab", { ...request, dryRun: false })
    expect(applied.archived).toHaveLength(2)
    expect(applied.readbacks).toHaveLength(2)
    for (const receipt of applied.readbacks) {
      expect(receipt).toMatchObject({ hotTip: null, coldTip: expect.any(String), readAt: expect.any(String) })
      expect(receipt.coldTip).toBe((await listRefs(receipt.coldRef, location)).get(receipt.coldRef))
      expect(receipt.previousTip).toBe(tips.get(receipt.branch))
    }
    for (const [branch, tip] of tips) {
      if (branch !== "task/merged" && branch !== "task/cancelled") {
        expect((await listRefs(changesRef("lab", branch), location)).get(changesRef("lab", branch))).toBe(tip)
        continue
      }
      expect((await listRefs(changesRef("lab", branch), location)).size).toBe(0)
      const state = await readStatus(location, "lab", branch)
      expect(state).toMatchObject({ status: branch.slice(5), commit: head, endedAt: at })
      const history = await readChangeEvents(location, "lab", branch, state.tip ?? "missing")
      expect(history.at(-1)).toMatchObject({
        type: "archived",
        parent: tip,
        props: expect.arrayContaining([
          ["Archive-Ref", changesRef("lab", branch)],
          ["Archive-Tip", tip],
          ["Archive-State", branch.slice(5)],
          ["Archive-EndedAt", at.toISOString()],
          ["Archive-AgeMs", String(now.getTime() - at.getTime())],
          ["Time", now.toISOString()],
        ]),
      })
    }
    expect(await archiveQueue(location, "lab", request)).toMatchObject({
      examined: 8,
      candidates: [],
      protected: 7,
      recent: 1,
    })
    // @failure 27957: the first live pass must filter safe endings, then sort oldest first, then cap.
    // The default-policy rows above cannot detect a cap applied before state/age filtering or sorting.
    for (const [name, state, days] of [
      ["a-younger", "merged", 30],
      ["z-oldest", "merged", 50],
      ["m-tie-old", "merged", 40],
      ["n-tie-old", "merged", 40],
      ["c-cancelled", "cancelled", 60],
      ["b-recent", "merged", 20],
    ] as const) {
      const ending = new Date(now.getTime() - days * 86_400_000)
      const chain = await openEvents({ ...store, ref: changesRef("lab", `task/${name}`) })
      await chain.append(
        [
          changeInput("opened", { queueTip, at: ending, commit: head, by: "@dev/6" }),
          changeInput(state, { queueTip, at: ending, commit: head, reason: "withdrawn" }),
        ],
        { expect: null },
      )
    }
    const bounded = { ...request, minAgeDays: 30, state: "merged" as const, limit: 2 }
    const boundedPreview = await archiveQueue(location, "lab", bounded)
    expect(boundedPreview).toMatchObject({
      bounds: { minAgeDays: 30, states: ["merged"], limit: 2 },
      retentionMs: 30 * 86_400_000,
      eligible: 4,
      archived: [],
    })
    expect(boundedPreview.candidates.map((row) => row.branch)).toEqual(["task/z-oldest", "task/m-tie-old"])
    const beforeBounds = await listRefs("refs/", location)
    for (const [bounds, refusal] of [
      [{ minAgeDays: 6 }, /--min-age/],
      [{ minAgeDays: 7.5 }, /--min-age/],
      [{ limit: 0 }, /--limit/],
      [{ limit: 1.5 }, /--limit/],
      [{ state: "other" as "merged" }, /--state/],
    ] as const) {
      await expect(archiveQueue(location, "lab", { ...request, ...bounds, dryRun: false })).rejects.toThrow(refusal)
    }
    expect(await listRefs("refs/", location)).toEqual(beforeBounds)
    const boundedApplied = await archiveQueue(location, "lab", { ...bounded, dryRun: false })
    expect(boundedApplied.candidates).toEqual(boundedPreview.candidates)
    expect(boundedApplied).toMatchObject({ eligible: 4, bounds: boundedPreview.bounds })
    expect(boundedApplied.archived).toHaveLength(2)
    expect(boundedApplied.readbacks.map((row) => row.ref)).toEqual(boundedPreview.candidates.map((row) => row.ref))
    for (const name of ["a-younger", "n-tie-old", "c-cancelled", "b-recent"]) {
      expect((await listRefs(changesRef("lab", `task/${name}`), location)).size).toBe(1)
    }
  })

  /** @failure 27957: queue/cold contention must abort without overwrite or retry; later failure names partial custody.
   * @level l1 @consumer manual yrd queue archive
   * The hot-tip race cannot detect omitted queue/absent-cold leases or a misleading all-or-nothing error.
   * Uses the existing backend fixture; no production seam is added.
   */
  it.each([
    "cold-first",
    "queue-first",
    "queue-second",
    "transport-second",
    "readback-missing",
    "readback-moved",
    "readback-hot",
    "readback-error",
  ] as const)("stops archive custody on %s and reports the committed prefix", async (race) => {
    const { store, location, beforeNextPublish } = remoteMemStore(`archive-${race}`)
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const head = (await target.transact(async (map) => map.set("work", "retained"), "work")).oid
    const at = new Date("2026-09-22T14:00:00.000Z")
    const now = new Date("2026-10-07T12:00:00.000Z")
    const queueTip = await seedEventQueue(location, "lab", head, at)
    const tips = new Map<string, string>()
    for (const branch of ["task/a", "task/b"]) {
      const result = await (
        await openEvents({ ...store, ref: changesRef("lab", branch) })
      ).append(
        [
          changeInput("opened", { queueTip, at, commit: head, by: "@dev/6" }),
          changeInput("merged", { queueTip, at, commit: head }),
        ],
        { expect: null },
      )
      if (result.head === null) throw new Error("fixture lost merged tip")
      tips.set(branch, result.head)
    }
    const coldA = "refs/yrd-archive/lab/task/a"
    const coldB = "refs/yrd-archive/lab/task/b"
    const originalRefReader = location.backend.listRefs
    let rivalQueueTip = queueTip
    const contend = async () => {
      if (race === "cold-first") {
        if (location.backend.publish === undefined) throw new Error("fixture lacks publisher")
        await location.backend.publish(location.repo, [{ ref: coldA, expect: "0".repeat(40), oid: head }], "origin")
      } else if (race === "transport-second") {
        throw new Error("fixture archive transport refused")
      } else {
        rivalQueueTip = await writeQueueEvent(location, "lab", {
          type: "observed",
          commit: head,
          by: QUEUE_RUN_WRITER,
          at: now,
        })
      }
    }
    const readback = race.startsWith("readback-")
    const transferred = race.endsWith("second") || readback ? 1 : 0
    if (readback) {
      const list = location.backend.listRefs
      if (list === undefined) throw new Error("fixture lacks ref reader")
      location.backend.listRefs = async (repo, selection, remote) => {
        const actual = await list(repo, selection, remote)
        if (selection !== "refs/" || !actual.has(coldA)) return actual
        if (race === "readback-error") throw new Error("fixture origin readback unavailable")
        const observed = new Map(actual)
        if (race === "readback-missing") observed.delete(coldA)
        if (race === "readback-moved") observed.set(coldA, head)
        if (race === "readback-hot") observed.set(changesRef("lab", "task/a"), tips.get("task/a")!)
        return observed
      }
    } else if (transferred === 1) {
      beforeNextPublish(async () => {
        beforeNextPublish(contend)
      })
    } else beforeNextPublish(contend)
    let refusal: unknown
    try {
      await archiveQueue(location, "lab", { dryRun: false, by: "@dev/6", at: now })
    } catch (error) {
      refusal = error
    }
    location.backend.listRefs = originalRefReader
    expect(refusal, String(refusal)).toBeInstanceOf(race === "transport-second" || readback ? Error : Conflict)
    const failedRef = changesRef("lab", transferred === 1 && !readback ? "task/b" : "task/a")
    expect(String(refusal)).toContain(`archive stopped at ${failedRef} after ${transferred}/2 transfers`)
    if (readback) expect(String(refusal)).toContain("archive-custody-readback")
    if (transferred === 1 && !readback) {
      expect(String(refusal)).toContain(`"coldRef":"${coldA}"`)
      expect(String(refusal)).toContain(`"previousTip":"${tips.get("task/a")}"`)
      expect(String(refusal)).toContain('"readAt":')
    }
    const refs = await listRefs("refs/", location)
    expect(refs.get(queueRef("lab"))).toBe(rivalQueueTip)
    expect(refs.get(changesRef("lab", "task/b"))).toBe(tips.get("task/b"))
    expect(refs.has(coldB)).toBe(false)
    if (transferred === 0) {
      expect(refs.get(changesRef("lab", "task/a"))).toBe(tips.get("task/a"))
      expect(refs.get(coldA)).toBe(race === "cold-first" ? head : undefined)
    } else {
      expect(refs.has(changesRef("lab", "task/a"))).toBe(false)
      const retained = await readStatus(location, "lab", "task/a")
      expect(retained).toMatchObject({ status: "merged", commit: head, endedAt: at })
      expect(refs.get(coldA)).toBe(retained.tip)
    }
  })

  // @failure Local retirement deletes the remote branch or ends without an event on its chain that keeps the tip (28791, 30683).
  // @level l1
  // @consumer Yrd local branch retirement; positional drop continues to delete the remote branch.
  it.each(["draft", "submitted", "publication-refused"] as const)(
    "keeps a %s local retirement's tip on its chain without deleting the remote branch",
    async (state) => {
      const { store, location, beforeNextPublish } = remoteMemStore(`yrd-local-retirement-${state}`)
      const target = await open({ ...store, ref: "refs/heads/lab" })
      const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
      const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
      const branch = "task/local-drop"
      const source = await open({ ...store, ref: `refs/heads/${branch}` })
      const head = (await source.transact(async (map) => map.set("work", "one"), "work")).oid
      if (state === "submitted") {
        await (
          await openEvents({ ...store, ref: changesRef("lab", branch) })
        ).append(
          [
            changeInput("opened", {
              queueTip,
              at: new Date("2026-09-22T14:01:00.000Z"),
              commit: head,
              by: "@dev/2",
              issue: "28791",
            }),
          ],
          { expect: null },
        )
      }
      const request = {
        queue: "lab",
        branch,
        by: "@dev/2",
        issue: "28791",
        note: "issue closed",
        local: { tip: head },
      }
      if (state === "publication-refused") {
        beforeNextPublish(async () => {
          throw new Error("fixture refused event publication")
        })
        await expect(drop(location, request)).rejects.toThrow(/fixture refused event publication.*local refs kept/)
        const refused = await listRefs("refs/", store)
        expect(refused.get(`refs/heads/${branch}`)).toBe(head)
        expect(refused.has(changesRef("lab", branch))).toBe(false)
      }
      const result = await drop(location, request)
      const refs = await listRefs("refs/", store)
      expect(refs.get(`refs/heads/${branch}`)).toBe(head)
      expect([...refs.keys()].filter((name) => name.startsWith("refs/archive/"))).toEqual([])
      const history = await (await openEvents({ ...store, ref: changesRef("lab", branch) })).events()
      expect(result.ref).toBe(changesRef("lab", branch))
      expect(history.at(-1)).toMatchObject({ id: result.event, type: "cancelled", links: [head] })
      expect(await readStatus(location, "lab", branch)).toMatchObject({
        status: "cancelled",
        reason: "dropped",
        issue: "28791",
      })
      expect(await drop(location, request)).toEqual(result)
      expect((await listRefs("refs/", store)).get(`refs/heads/${branch}`)).toBe(head)
    },
  )

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
    await expect(drop(location, { queue: "lab", branch: "task/never", by: "@dev/2" })).rejects.toThrow(
      /there is no branch to drop/,
    )
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
    await expect(drop(location, { queue: "lab", branch: "task/absent", by: "@dev/2" })).rejects.toThrow(/--reason/)
    expect(await chain.head()).toBe(failed.head)
    const dropped = await drop(location, {
      queue: "lab",
      branch: "task/absent",
      by: "@dev/2",
      note: "owner retired the failed change",
    })
    expect(await readStatus(location, "lab", "task/absent")).toMatchObject({
      status: "cancelled",
      reason: "dropped",
      commit: head,
    })
    expect((await chain.events()).at(-1)).toMatchObject({ id: dropped.event, type: "cancelled", links: [head] })
  })

  // @failure an owner drop after a failed ending deletes the name but leaves Df seeing a failure (26223).
  it("records an owner drop after an ended change and deletes its kept branch in one publish", async () => {
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
    await expect(drop(location, { queue: "lab", branch: "task/ended", by: "@dev/2" })).rejects.toThrow(/--reason/)
    expect(await branch.head()).toBe(head)
    expect(await chain.head()).toBe(failed.head)
    const dropped = await drop(location, {
      queue: "lab",
      branch: "task/ended",
      by: "@dev/2",
      note: "owner retired the failed change",
    })
    expect(await chain.head()).toBe(dropped.event)
    expect((await listRefs("refs/heads/task/ended", store)).size).toBe(0)
    expect(await readStatus(location, "lab", "task/ended")).toMatchObject({
      status: "cancelled",
      reason: "dropped",
      commit: head,
    })
    expect((await chain.events()).at(-1)).toMatchObject({
      id: dropped.event,
      type: "cancelled",
      links: [head],
      content: "owner retired the failed change",
      props: expect.arrayContaining([
        ["By", "@dev/2"],
        ["Reason", "dropped"],
      ]),
    })
  })

  it.each(["hot", "cold"] as const)("only deletes the branch name of a %s merged change", async (custody) => {
    const { store, location } = remoteMemStore("yrd-event-drop-merged")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: "refs/heads/task/merged" })
    const head = (await branch.transact(async (map) => map.set("work", "one"), "work")).oid
    const chain = await openEvents({ ...store, ref: changesRef("lab", "task/merged") })
    const opened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head, by: "@dev/2" })],
      { expect: null },
    )
    const merged = await chain.append(
      [changeInput("merged", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), commit: head })],
      { expect: opened.head },
    )
    // @failure 27957: an owner drop must keep archived merge history and never create a new cancelled hot chain.
    // The original hot-only case cannot detect a cold merge being treated as an unseen branch.
    const ref = custody === "hot" ? changesRef("lab", "task/merged") : "refs/yrd-archive/lab/task/merged"
    if (custody === "cold") {
      if (store.backend.publish === undefined || merged.head === null) throw new Error("fixture lacks cold custody")
      await store.backend.publish(store.repo, [
        { ref, expect: "0".repeat(40), oid: merged.head },
        { ref: changesRef("lab", "task/merged"), expect: merged.head, oid: null },
      ])
    }
    // The previous branch-absence assertion missed missing custody and skipped
    // host protections on hot/cold ended changes (29399).
    await expect(
      drop(location, {
        queue: "lab",
        branch: "task/merged",
        by: "@dev/2",
        retire: { tip: head },
        note: "retire merged work",
        protections: async () => ["author environment is held"],
      }),
    ).rejects.toThrow(/author environment is held/)
    expect(await branch.head()).toBe(head)
    let checks = 0
    const dropped = await drop(location, {
      queue: "lab",
      branch: "task/merged",
      by: "@dev/2",
      protections: async () => {
        checks++
        expect(await branch.head()).toBe(head)
        return []
      },
    })
    expect(checks).toBe(2)
    expect(dropped).toMatchObject({ head, event: merged.head })
    await expect(
      drop(location, {
        queue: "lab",
        branch: "task/merged",
        by: "@dev/2",
        retire: { tip: head },
        note: "already retired",
      }),
    ).resolves.toMatchObject({ head, event: merged.head })
    expect((await listRefs(ref, store)).get(ref)).toBe(merged.head)
    if (custody === "cold") expect(await chain.head()).toBeNull()
    expect((await listRefs("refs/heads/task/merged", store)).size).toBe(0)
    expect((await readStatus(location, "lab", "task/merged")).status).toBe("merged")
  })

  /** @failure A merged head that published main already holds still gets an archive ref, or a retry after its removal fails (30683).
   * @level l2 @consumer public drop and drop --retire of a merged change, and retirement retry
   * ADR-0018's amendment (line 69): a tip proven an ancestor of fresh published main needs neither an event nor an archive.
   */
  it.each(["drop", "retire"] as const)(
    "30683: %s of a merged head that published main holds writes no archive ref",
    async (mode) => {
      const { store, location } = remoteMemStore(`yrd-30683-${mode}`)
      const target = await open({ ...store, ref: "refs/heads/lab" })
      const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
      const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
      const branch = await open({ ...store, ref: "refs/heads/task/landed" })
      const head = (await branch.transact(async (map) => map.set("work", "one"), "work")).oid
      const chain = await openEvents({ ...store, ref: changesRef("lab", "task/landed") })
      const opened = await chain.append(
        [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head, by: "@dev/2" })],
        { expect: null },
      )
      const merged = await chain.append(
        [changeInput("merged", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), commit: head })],
        { expect: opened.head },
      )
      if (store.backend.publish === undefined || store.backend.listRefs === undefined) {
        throw new Error("fixture lacks ref publication")
      }
      await store.backend.publish(store.repo, [{ ref: "refs/heads/lab", expect: base, oid: head }])
      const archives = async (): Promise<string[]> => [
        ...(await store.backend.listRefs!(store.repo, "refs/archive/")).keys(),
      ]
      const request = {
        queue: "lab",
        branch: "task/landed",
        by: "@dev/2",
        protections: async () => [],
        ...(mode === "retire" ? { retire: { tip: head }, note: "retire merged work" } : {}),
      }
      const dropped = await drop(location, request)
      expect(dropped).toMatchObject({ head, event: merged.head, main: { ref: "refs/heads/lab", tip: head } })
      expect(await archives()).toEqual([])
      expect((await listRefs("refs/heads/task/landed", store)).size).toBe(0)
      expect((await listRefs(changesRef("lab", "task/landed"), store)).get(changesRef("lab", "task/landed"))).toBe(
        merged.head,
      )
      expect((await readStatus(location, "lab", "task/landed")).status).toBe("merged")
      if (mode === "retire") {
        await expect(drop(location, { ...request, note: "retry" })).resolves.toMatchObject({
          head,
          event: merged.head,
          main: { ref: "refs/heads/lab", tip: head },
        })
        expect(await archives()).toEqual([])
      }
    },
  )

  /** @failure Explicit merged retirement loses an unlinked divergent head, duplicates retention on retry, or rewrites merge facts.
   * @level l2 @consumer public drop against native hot/cold Git refs, and retirement retry
   * Existing retained-reader fixtures append the event directly; the retirement fixture uses a head already kept by the merge.
   */
  it.each(["hot", "cold"] as const)(
    "30432: explicitly retires a divergent merged head from %s custody",
    async (custody) => {
      const root = mkdtempSync(join(tmpdir(), `yrd-30432-${custody}-`))
      const origin = mkdtempSync(join(tmpdir(), `yrd-30432-${custody}-origin-`))
      const git = gitIn(root)
      await git(["init", "--quiet"])
      await git(["init", "--bare", "--quiet", origin])
      await git(["remote", "add", "origin", origin])
      await git(["config", "user.name", "fixture"])
      await git(["config", "user.email", "fixture@yrd.test"])
      const commit = async (name: string, body: string): Promise<string> => {
        writeFileSync(join(root, name), body)
        await git(["add", name])
        await git(["commit", "--quiet", "-m", name])
        return (await git(["rev-parse", "HEAD"])).trim()
      }
      const base = await commit("base", "base\n")
      await git(["update-ref", "refs/heads/lab", base])
      await git(["push", "--quiet", "origin", "refs/heads/lab:refs/heads/lab"])
      const branch = `task/30432-${custody}`
      const branchRef = `refs/heads/${branch}`
      await git(["checkout", "--quiet", "-b", branch, base])
      const mergedHead = await commit("merged", "merged side\n")
      await git(["push", "--quiet", "origin", `${branchRef}:${branchRef}`])
      await git(["checkout", "--quiet", "--detach", base])
      const extra = await commit("extra", "unmerged sibling\n")
      expect((await git(["merge-base", mergedHead, extra])).trim()).toBe(base)
      await git(["push", "--quiet", "--force", "origin", `${extra}:${branchRef}`])
      const store = { repo: root, backend: git.backend }
      const location = { ...store, remote: "origin", selection: git.selection }
      const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
      const hotRef = changesRef("lab", branch)
      const chain = await openEvents({ ...location, ref: hotRef })
      const opened = await chain.append(
        [
          changeInput("opened", {
            queueTip,
            at: new Date("2026-09-22T14:01:00.000Z"),
            commit: mergedHead,
            by: "@dev/3",
            issue: "30432",
          }),
        ],
        { expect: null },
      )
      const merged = await chain.append(
        [changeInput("merged", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), commit: mergedHead })],
        { expect: opened.head },
      )
      const selectedRef = custody === "hot" ? hotRef : `refs/yrd-archive/lab/${branch}`
      if (custody === "cold") {
        await git.backend.publish!(
          root,
          [
            { ref: selectedRef, expect: "0".repeat(40), oid: merged.head! },
            { ref: hotRef, expect: merged.head!, oid: null },
          ],
          "origin",
        )
      }
      const publish = git.backend.publish
      if (publish === undefined) throw new Error("fixture lacks publication")
      const refTipBefore = (await listRefs(selectedRef, location)).get(selectedRef)
      const ordinaryDrop = await drop(location, { queue: "lab", branch, by: "@dev/3" }).then(
        () => undefined,
        (error: unknown) => String(error),
      )
      expect(ordinaryDrop).toContain("kept-link retirement, 25671")
      expect(ordinaryDrop).toContain(`--retire --tip ${extra} --reason <why>`)
      expect(ordinaryDrop).toContain("30432")
      expect((await listRefs(branchRef, location)).get(branchRef)).toBe(extra)
      expect((await listRefs(selectedRef, location)).get(selectedRef)).toBe(refTipBefore)

      let racedSelectedTip: string | undefined
      const staleSelectedTip = await drop(location, {
        queue: "lab",
        branch,
        by: "@dev/3",
        note: "retain the exact divergent head",
        retire: { tip: extra },
        protections: async () => {
          const selected = await readBranchHistory(location, "lab", branch)
          expect(selected.history?.events.some((item) => item.type === "retained")).toBe(false)
          if (selected.history?.state.tip === undefined) throw new Error("selected history lacks its CAS tip")
          const concurrentNotice = changeInput("notified", {
            queueTip,
            at: new Date("2026-10-20T12:00:00.000Z"),
            notice: {
              for: merged.events.at(-1)!.id,
              to: "first-racer",
              key: `${merged.events.at(-1)!.id}:first-racer`,
              result: "delivered",
            },
          })
          const competing = await (
            await openEvents({ ...location, ref: selectedRef })
          ).append([concurrentNotice], {
            expect: selected.history.state.tip,
          })
          racedSelectedTip = competing.head ?? undefined
          return []
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(staleSelectedTip).toBeInstanceOf(Conflict)
      expect(racedSelectedTip).toBeDefined()
      const afterSelectedRace = await readBranchHistory(location, "lab", branch)
      expect(afterSelectedRace.history?.events.at(-1)?.id).toBe(racedSelectedTip)
      expect(afterSelectedRace.history?.events.some((item) => item.type === "retained")).toBe(false)
      expect((await listRefs(branchRef, location)).get(branchRef)).toBe(extra)
      const before = await readStatus(location, "lab", branch)

      let readbackRaced = false
      const readbackBackend: GitomicBackend = {
        ...git.backend,
        publish: async (repo, updates, remote) => {
          const result = await publish(repo, updates, remote)
          const retainedUpdate = updates.find((update) => update.ref === selectedRef && update.oid !== null)
          if (!readbackRaced && retainedUpdate?.oid !== null && retainedUpdate?.oid !== undefined) {
            readbackRaced = true
            const written = await readBranchHistory(location, "lab", branch)
            const retained = written.history?.events.find((item) => item.id === retainedUpdate.oid)
            expect(retained?.type).toBe("retained")
            expect(retained?.links).toContain(extra)
            expect(written.history?.state).toEqual({ ...before, tip: retainedUpdate.oid })
            const next = changeInput("notified", {
              queueTip,
              at: new Date("2026-10-20T12:01:00.000Z"),
              notice: {
                for: merged.events.at(-1)!.id,
                to: "readback-racer",
                key: `${merged.events.at(-1)!.id}:readback-racer`,
                result: "delivered",
              },
            })
            await (await openEvents({ ...location, ref: selectedRef })).append([next], { expect: retainedUpdate.oid })
          }
          return result
        },
      }
      let preRetentionChecks = 0
      const readbackProtections = async () => {
        preRetentionChecks++
        const selected = await readBranchHistory(location, "lab", branch)
        expect(selected.history?.events.some((item) => item.type === "retained")).toBe(false)
        expect(selected.history?.state).toEqual(before)
        return []
      }
      const readbackFailure = await drop(
        { ...location, backend: readbackBackend },
        {
          queue: "lab",
          branch,
          by: "@dev/3",
          note: "retain the exact divergent head",
          retire: { tip: extra },
          protections: readbackProtections,
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(readbackFailure).toBeInstanceOf(Error)
      expect(readbackRaced).toBe(true)
      expect(preRetentionChecks).toBe(1)
      const afterReadbackRace = await readBranchHistory(location, "lab", branch)
      expect(afterReadbackRace.history?.events.filter((item) => item.type === "retained")).toHaveLength(1)
      expect(afterReadbackRace.history?.events.at(-1)?.type).toBe("notified")
      expect((await listRefs(branchRef, location)).get(branchRef)).toBe(extra)
      const beforeDeleteRetry = await readStatus(location, "lab", branch)

      let rejectDelete = true
      const flakyBackend: GitomicBackend = {
        ...git.backend,
        publish: async (repo, updates, remote) => {
          if (rejectDelete && updates.some((update) => update.ref === branchRef && update.oid === null)) {
            rejectDelete = false
            throw new Conflict("fixture refused one branch deletion")
          }
          return await publish(repo, updates, remote)
        },
      }
      const flakyLocation = { ...location, backend: flakyBackend }
      let protectionChecks = 0
      const protections = async () => {
        protectionChecks++
        const selected = await readBranchHistory(flakyLocation, "lab", branch)
        const retainedEvent = selected.history?.events.find((item) => item.type === "retained")
        expect((await listRefs(branchRef, flakyLocation)).get(branchRef)).toBe(extra)
        expect(retainedEvent?.links).toContain(extra)
        expect(selected.ref).toBe(selectedRef)
        expect(selected.history?.state).toEqual(beforeDeleteRetry)
        return []
      }
      const request = {
        queue: "lab",
        branch,
        by: "@dev/3",
        note: "retain the exact divergent head before retirement",
        retire: { tip: extra },
        protections,
      }
      await expect(drop(flakyLocation, request)).rejects.toThrow("fixture refused one branch deletion")
      expect(protectionChecks).toBeGreaterThan(1)
      const retainedHistory = await readBranchHistory(location, "lab", branch)
      const retainedEvent = retainedHistory.history?.events.find((item) => item.type === "retained")
      expect(retainedEvent?.links).toContain(extra)
      expect(retainedHistory.history?.state).toEqual(beforeDeleteRetry)
      expect((await listRefs(branchRef, location)).get(branchRef)).toBe(extra)

      const retry =
        custody === "hot"
          ? await drop(location, { queue: "lab", branch, by: "@dev/3", protections })
          : await drop(location, request)
      expect(retry).toMatchObject({ head: extra, event: merged.head })
      const afterRetry = await readBranchHistory(location, "lab", branch)
      expect(afterRetry.history?.events.filter((item) => item.type === "retained")).toHaveLength(1)
      expect(afterRetry.history?.state).toEqual(beforeDeleteRetry)
      expect((await listRefs(branchRef, location)).has(branchRef)).toBe(false)

      let absentPublishes = 0
      const readOnlyBackend: GitomicBackend = {
        ...git.backend,
        publish: async () => {
          absentPublishes++
          throw new Error("absent retirement retry must not publish")
        },
      }
      const absent = await drop({ ...location, backend: readOnlyBackend }, request)
      expect(absent).toEqual(retry)
      expect(absentPublishes).toBe(0)
      expect((await listRefs(selectedRef, location)).get(selectedRef)).toBe(afterRetry.history?.state.tip)
    },
  )

  // 29399: the old delete-only tests missed terminal-only selection, archive
  // custody races and host protections changing between custody and deletion.
  // These faults use the existing publish hooks and exercise the public drop API.
  it.each([
    "open",
    "wrong-tip",
    "unreadable",
    "held-later",
    "branch-moved",
    "ending-hot",
    "ending-cold",
    "ending-final",
  ] as const)("keeps exact retirement custody loud on %s", async (fault) => {
    const { store, location, afterNextPublish } = remoteMemStore(`retire-${fault}`)
    const branchName = "task/retire"
    const branchRef = `refs/heads/${branchName}`
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: branchRef })
    const head = (await branch.transact(async (map) => map.set("work", "one"), "work")).oid
    const hot = changesRef("lab", branchName)
    const ref = fault === "ending-cold" ? "refs/yrd-archive/lab/task/retire" : hot
    const chain = await openEvents({ ...store, ref: hot })
    let ending = (
      await chain.append(
        [
          changeInput("opened", { queueTip, at: new Date(), commit: head, by: "@dev/2" }),
          ...(fault === "open" ? [] : [changeInput("merged", { queueTip, at: new Date(), commit: head })]),
        ],
        { expect: null },
      )
    ).head
    const publish = store.backend.publish
    if (publish === undefined || ending === null) throw new Error("fixture lacks retirement refs")
    if (ref !== hot) {
      await publish(store.repo, [
        { ref, expect: "0".repeat(40), oid: ending },
        { ref: hot, expect: ending, oid: null },
      ])
    }
    let checks = 0
    let expectedBranch: string | null = head
    const action = drop(location, {
      queue: "lab",
      branch: branchName,
      by: "@dev/2",
      note: "retire exact ended work",
      retire: { tip: fault === "wrong-tip" ? base : head },
      protections: async () => {
        checks++
        if (fault === "unreadable") throw new Error("host protection census unreadable")
        if (checks !== 2) return []
        if (fault === "held-later") return ["author became held"]
        if (fault === "branch-moved") {
          expectedBranch = (await branch.transact(async (map) => map.set("work", "new"), "advanced")).oid
        }
        if (fault === "ending-hot" || fault === "ending-cold") {
          ending = (
            await (
              await openEvents({ ...store, ref })
            ).append([changeInput("opened", { queueTip, at: new Date(), commit: head, by: "@dev/rival" })], {
              expect: ending,
            })
          ).head
        }
        if (fault === "ending-final") {
          expectedBranch = null
          afterNextPublish(async () => {
            ending = (
              await (
                await openEvents({ ...store, ref })
              ).append([changeInput("opened", { queueTip, at: new Date(), commit: head, by: "@dev/rival" })], {
                expect: ending,
              })
            ).head
          })
        }
        return []
      },
    })
    const refusal = await action.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refusal).toBeInstanceOf(Error)
    if (fault === "ending-final") {
      expect(String(refusal)).toContain("change moved during retirement")
      expect(String(refusal)).toContain(`git -C 'retire-ending-final' branch '${branchName}' '${head}'`)
    }
    expect((await listRefs(branchRef, store)).get(branchRef) ?? null).toBe(expectedBranch)
    expect((await listRefs(ref, store)).get(ref)).toBe(ending)
  })

  // @failure a rival branch move after an ended drop publishes would retire work the event did not keep (26223).
  it("leaves an ended change untouched when its branch-delete lease loses", async () => {
    const { store, location, beforeNextPublish } = remoteMemStore("yrd-event-drop-ended-race")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const base = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: "refs/heads/task/ended-race" })
    const head = (await branch.transact(async (map) => map.set("work", "one"), "work")).oid
    const chain = await openEvents({ ...store, ref: changesRef("lab", "task/ended-race") })
    const opened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head, by: "@dev/2" })],
      { expect: null },
    )
    const failed = await chain.append(
      [changeInput("failed", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), reason: "check failed" })],
      { expect: opened.head },
    )
    let rival = ""
    beforeNextPublish(async () => {
      rival = (await branch.transact(async (map) => map.set("work", "two"), "rival head")).oid
    })
    await expect(
      drop(location, { queue: "lab", branch: "task/ended-race", by: "@dev/2", note: "retire" }),
    ).rejects.toBeInstanceOf(Conflict)
    expect(await branch.head()).toBe(rival)
    expect(await chain.head()).toBe(failed.head)
  })

  // @failure delete-only drop loses a branch's newer, unkept commit (ADR-0018 / 25658).
  it("refuses an ended branch whose current head is not already kept by its chain", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-event-drop-ended-advanced-"))
    const origin = mkdtempSync(join(tmpdir(), "yrd-event-drop-ended-advanced-origin-"))
    const git = gitIn(root)
    await git(["init", "--quiet"])
    await git(["init", "--bare", "--quiet", origin])
    await git(["remote", "add", "origin", origin])
    await git(["config", "user.name", "fixture"])
    await git(["config", "user.email", "fixture@yrd.test"])
    writeFileSync(join(root, "work"), "one\n")
    await git(["add", "work"])
    await git(["commit", "-m", "kept", "--quiet"])
    const kept = (await git(["rev-parse", "HEAD"])).trim()
    writeFileSync(join(root, "work"), "two\n")
    await git(["add", "work"])
    await git(["commit", "-m", "advanced", "--quiet"])
    const advanced = (await git(["rev-parse", "HEAD"])).trim()
    await git(["update-ref", "refs/heads/lab", kept])
    await git(["update-ref", "refs/heads/task/advanced", advanced])
    await git([
      "push",
      "--quiet",
      "origin",
      "refs/heads/lab:refs/heads/lab",
      "refs/heads/task/advanced:refs/heads/task/advanced",
    ])
    const store = { repo: root, backend: git.backend }
    const location = { ...store, remote: "origin", selection: git.selection }
    const queueTip = await seedEventQueue(location, "lab", kept, new Date("2026-09-22T14:00:00.000Z"))
    const chain = await openEvents({ ...location, ref: changesRef("lab", "task/advanced") })
    const opened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: kept, by: "@dev/2" })],
      { expect: null },
    )
    const failed = await chain.append(
      [changeInput("failed", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), reason: "check failed" })],
      { expect: opened.head },
    )
    await expect(
      drop(location, { queue: "lab", branch: "task/advanced", by: "@dev/2", note: "retire" }),
    ).rejects.toThrow(new RegExp(`task/advanced.*${advanced}.*${kept}`))
    expect((await git(["rev-parse", "refs/heads/task/advanced"])).trim()).toBe(advanced)
    expect(await chain.head()).toBe(failed.head)

    // A remote deletion leaves a real local branch behind. The memory-store
    // race row above could not prove that its printed recovery actually runs.
    const publish = git.backend.publish
    if (publish === undefined) throw new Error("native fixture lacks publication")
    const outside = outsideRepositoryRoot()
    for (const [kind, localBranch] of [
      ["event", true],
      ["published-main", true],
      ["published-main", false],
    ] as const) {
      const branch = `task/race'${kind}${localBranch ? "" : "-absent"}`
      const branchRef = `refs/heads/${branch}`
      await git(["branch", branch, kept])
      await git(["push", "--quiet", "origin", branchRef])
      if (!localBranch) await git(["update-ref", "-d", branchRef, kept])
      const eventRef = changesRef("lab", branch)
      const raceChain = await openEvents({ ...location, ref: eventRef })
      const start = await raceChain.append(
        [changeInput("opened", { queueTip, at: new Date(), commit: kept, by: "fixture" })],
        { expect: null },
      )
      const end = await raceChain.append(
        [changeInput("failed", { queueTip, at: new Date(), reason: "fixture ending" })],
        { expect: start.head },
      )
      const startTip = start.head
      const endTip = end.head
      if (startTip === null || endTip === null) throw new Error("retirement race fixture lacks its event tips")
      const authority =
        kind === "event" ? { kind, ref: eventRef, tip: endTip } : { kind, ref: "refs/heads/lab", tip: kept }
      const movedTip = kind === "event" ? startTip : advanced
      let moved = false
      const backend: GitomicBackend = {
        ...git.backend,
        publish: async (repo, updates, remote) => {
          const result = await publish(repo, updates, remote)
          if (updates.some((update) => update.ref === branchRef && update.oid === null)) {
            moved = true
            await publish(repo, [{ ref: authority.ref, expect: authority.tip, oid: movedTip }], remote)
          }
          return result
        },
      }
      const refusal = await retireOriginBranch({ ...location, backend }, { branch, head: kept, authority }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(moved, kind).toBe(true)
      expect(String(refusal)).toContain("moved during retirement")
      expect((await git(["ls-remote", "origin", branchRef])).trim()).toBe("")
      const recovery = /(git -C .+)$/u.exec(String(refusal))?.[1]
      if (recovery === undefined) throw new Error(`${kind} retirement supplied no recovery recipe`)
      const before = await git(["ls-remote", "origin"])
      const restored = spawnSync("/bin/sh", ["-c", recovery], { cwd: outside, encoding: "utf8" })
      expect.soft(restored.status, `${kind}: ${restored.stderr}`).toBe(0)
      expect(restored.stdout.trim()).toBe(localBranch ? `${kept} ${branchRef}` : "")
      expect((await git(["rev-parse", branchRef])).trim()).toBe(kept)
      expect(await git(["ls-remote", "origin"])).toBe(before)
      if (kind === "published-main") {
        await publish(root, [{ ref: authority.ref, expect: movedTip, oid: authority.tip }], "origin")
      }
    }

    // Neither surviving-branch row proves recovery when only origin keeps the
    // payload, here through the change's event chain alone: no archive is
    // written (30683). Clear this disposable clone's custody after real remote deletion.
    const originOnlyBranch = "task/race'origin-only"
    const originOnlyRef = `refs/heads/${originOnlyBranch}`
    await git(["checkout", "--quiet", "-b", originOnlyBranch, advanced])
    writeFileSync(join(root, "origin-only"), "unique remote custody\n")
    await git(["add", "origin-only"])
    await git(["commit", "--quiet", "-m", "origin-only payload"])
    const originOnlyHead = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", originOnlyRef])
    await git(["checkout", "--quiet", "--detach", advanced])
    const originOnlyEventRef = changesRef("lab", originOnlyBranch)
    const originOnlyChain = await openEvents({ ...location, ref: originOnlyEventRef })
    const originOnlyStart = await originOnlyChain.append(
      [changeInput("opened", { queueTip, at: new Date(), commit: originOnlyHead, by: "fixture" })],
      { expect: null },
    )
    const originOnlyEnd = await originOnlyChain.append(
      [changeInput("failed", { queueTip, at: new Date(), reason: "origin-only ending" })],
      { expect: originOnlyStart.head },
    )
    const originOnlyStartTip = originOnlyStart.head
    const originOnlyEndTip = originOnlyEnd.head
    if (originOnlyStartTip === null || originOnlyEndTip === null) {
      throw new Error("origin-only fixture lacks its event tips")
    }
    const originOnlyBackend: GitomicBackend = {
      ...git.backend,
      publish: async (repo, updates, remote) => {
        const result = await publish(repo, updates, remote)
        if (!updates.some((update) => update.ref === originOnlyRef && update.oid === null)) return result
        await publish(repo, [{ ref: originOnlyEventRef, expect: originOnlyEndTip, oid: originOnlyStartTip }], remote)
        const localCustody = (
          await git(["for-each-ref", `--contains=${originOnlyHead}`, "--format=%(refname) %(objectname)"])
        )
          .trim()
          .split("\n")
          .filter(Boolean)
        await publish(
          repo,
          localCustody.map((line) => {
            const [ref, expectedTip] = line.split(" ")
            if (ref === undefined || expectedTip === undefined) throw new Error("local custody row malformed")
            return { ref, expect: expectedTip, oid: null }
          }),
        )
        await git(["reflog", "expire", "--expire=now", "--all"])
        await git(["gc", "--prune=now", "--quiet"])
        return result
      },
    }
    const originOnlyRefusal = await retireOriginBranch(
      { ...location, backend: originOnlyBackend },
      {
        branch: originOnlyBranch,
        head: originOnlyHead,
        authority: { kind: "event", ref: originOnlyEventRef, tip: originOnlyEndTip },
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(String(originOnlyRefusal)).toContain("change moved during retirement")
    const absentObject = spawnSync("git", ["-C", root, "cat-file", "-e", originOnlyHead], { encoding: "utf8" })
    expect([1, 128]).toContain(absentObject.status)
    expect((await git(["for-each-ref", "--format=%(refname)", originOnlyRef])).trim()).toBe("")
    // The moved chain still reaches the opened event that keeps the head.
    expect((await git(["ls-remote", "origin", originOnlyEventRef])).trim()).toBe(
      `${originOnlyStartTip}\t${originOnlyEventRef}`,
    )
    expect((await git(["ls-remote", "origin", "refs/archive/*"])).trim()).toBe("")
    const withoutFetch = spawnSync("git", ["-C", root, "branch", originOnlyBranch, originOnlyHead], {
      cwd: outside,
      encoding: "utf8",
    })
    expect(withoutFetch.status, withoutFetch.stderr).toBe(128)
    const recovery = /(git -C .+)$/u.exec(String(originOnlyRefusal))?.[1]
    if (recovery === undefined) throw new Error("event retirement supplied no recovery recipe")
    const beforeRecovery = await git(["ls-remote", "origin"])
    const recovered = spawnSync("/bin/sh", ["-c", recovery], { cwd: outside, encoding: "utf8" })
    expect(recovered.status, recovered.stderr).toBe(0)
    expect((await git(["rev-parse", originOnlyRef])).trim()).toBe(originOnlyHead)
    expect(await git(["ls-remote", "origin"])).toBe(beforeRecovery)
  })

  /** @failure Removing the branch name leaves a divergent merged head without event custody once GC runs (30432, 30683).
   * @level l2 @consumer origin branch retirement, Git GC, and a fresh event-only consumer
   * No archive ref exists: the retained event is the only custody the head has after its branch goes.
   */
  it("30432: retained event alone preserves a divergent head through branch removal, GC and fresh fetch", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-30432-archive-loss-"))
    const origin = mkdtempSync(join(tmpdir(), "yrd-30432-archive-loss-origin-"))
    const git = gitIn(root)
    await git(["init", "--quiet"])
    await git(["init", "--bare", "--quiet", origin])
    await git(["remote", "add", "origin", origin])
    await git(["config", "user.name", "fixture"])
    await git(["config", "user.email", "fixture@yrd.test"])
    const commit = async (name: string, body: string): Promise<string> => {
      writeFileSync(join(root, name), body)
      await git(["add", name])
      await git(["commit", "--quiet", "-m", name])
      return (await git(["rev-parse", "HEAD"])).trim()
    }
    const base = await commit("base", "base\n")
    await git(["update-ref", "refs/heads/lab", base])
    await git(["push", "--quiet", "origin", "refs/heads/lab:refs/heads/lab"])
    const branch = "task/30432-archive-loss"
    const branchRef = `refs/heads/${branch}`
    await git(["checkout", "--quiet", "-b", branch, base])
    const mergedHead = await commit("merged", "merged sibling\n")
    await git(["push", "--quiet", "origin", `${branchRef}:${branchRef}`])
    await git(["checkout", "--quiet", "--detach", base])
    const extra = await commit("extra", "divergent payload\n")
    expect((await git(["merge-base", mergedHead, extra])).trim()).toBe(base)
    await git(["push", "--quiet", "--force", "origin", `${extra}:${branchRef}`])

    const store = { repo: root, backend: git.backend }
    const location = { ...store, remote: "origin", selection: git.selection }
    const queueTip = await seedEventQueue(location, "lab", base, new Date("2026-09-22T14:00:00.000Z"))
    const eventRef = changesRef("lab", branch)
    const chain = await openEvents({ ...location, ref: eventRef })
    const opened = await chain.append(
      [
        changeInput("opened", {
          queueTip,
          at: new Date("2026-09-22T14:01:00.000Z"),
          commit: mergedHead,
          by: "@dev/3",
          issue: "30432",
        }),
      ],
      { expect: null },
    )
    await chain.append(
      [changeInput("merged", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), commit: mergedHead })],
      { expect: opened.head },
    )
    const before = await readStatus(location, "lab", branch)
    const publish = git.backend.publish
    if (publish === undefined) throw new Error("native fixture lacks publication")
    let collected = false
    const backend: GitomicBackend = {
      ...git.backend,
      publish: async (repo, updates, remote) => {
        const result = await publish(repo, updates, remote)
        if (!collected && updates.some((update) => update.ref === branchRef && update.oid === null)) {
          collected = true
          const localCustody = (await git(["for-each-ref", `--contains=${extra}`, "--format=%(refname)"]))
            .trim()
            .split("\n")
            .filter((ref) => ref.length > 0 && ref !== eventRef)
          for (const ref of localCustody) await git(["update-ref", "-d", ref])
          await git(["checkout", "--quiet", "--detach", base])
          await git(["reflog", "expire", "--expire=now", "--all"])
          await git(["gc", "--prune=now", "--quiet"])
          const remoteReflog = spawnSync("git", ["--git-dir", origin, "reflog", "expire", "--expire=now", "--all"], {
            encoding: "utf8",
          })
          if (remoteReflog.status !== 0) throw new Error(`bare origin reflog expiry failed: ${remoteReflog.stderr}`)
          const remoteGc = spawnSync("git", ["--git-dir", origin, "gc", "--prune=now", "--quiet"], {
            encoding: "utf8",
          })
          if (remoteGc.status !== 0) throw new Error(`bare origin GC failed: ${remoteGc.stderr}`)
        }
        return result
      },
    }
    const dropped = await drop(
      { ...location, backend },
      {
        queue: "lab",
        branch,
        by: "@dev/3",
        note: "retain the divergent exact head",
        retire: { tip: extra },
      },
    )
    expect(dropped).toMatchObject({ head: extra, ref: eventRef })
    expect(collected).toBe(true)
    expect((await git(["ls-remote", "origin", branchRef])).trim()).toBe("")
    expect((await git(["ls-remote", "origin", "refs/archive/*"])).trim()).toBe("")
    const retained = await readBranchHistory(location, "lab", branch)
    expect(retained.ref).toBe(eventRef)
    expect(retained.history?.events.at(-1)).toMatchObject({ type: "retained", links: [extra] })
    expect(retained.history?.state).toEqual({ ...before, tip: retained.history?.state.tip })
    const keepingRefs = (await git(["for-each-ref", `--contains=${extra}`, "--format=%(refname) %(objectname)"]))
      .trim()
      .split("\n")
    expect(keepingRefs).toHaveLength(1)
    expect(keepingRefs[0]?.split(" ")[1]).toBe(retained.history?.state.tip)
    expect(await git(["cat-file", "-e", `${extra}^{commit}`])).toBe("")

    const consumer = mkdtempSync(join(tmpdir(), "yrd-30432-fresh-consumer-"))
    const initConsumer = spawnSync("git", ["init", "--bare", "--quiet", consumer], { encoding: "utf8" })
    expect(initConsumer.status, initConsumer.stderr).toBe(0)
    const fetched = spawnSync("git", ["--git-dir", consumer, "fetch", "--no-tags", origin, `${eventRef}:${eventRef}`], {
      encoding: "utf8",
    })
    expect(fetched.status, fetched.stderr).toBe(0)
    expect(
      spawnSync("git", ["--git-dir", consumer, "for-each-ref", "--format=%(refname)"], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe(eventRef)
    expect(
      spawnSync("git", ["--git-dir", consumer, "cat-file", "-e", `${extra}^{commit}`], { encoding: "utf8" }).status,
    ).toBe(0)
    const fetchedEvent = spawnSync("git", ["--git-dir", consumer, "rev-parse", eventRef], { encoding: "utf8" })
    expect(fetchedEvent.status, fetchedEvent.stderr).toBe(0)
    const fetchedParents = spawnSync("git", ["--git-dir", consumer, "show", "-s", "--format=%P", eventRef], {
      encoding: "utf8",
    })
    expect(fetchedParents.status, fetchedParents.stderr).toBe(0)
    expect(fetchedParents.stdout.trim().split(/\s+/u)).toContain(extra)
  })

  // @failure an ended retire tip behind its own kept link is refused, so a shipped head cannot be deleted (25671).
  it("drops an ended branch whose head is behind its kept link and refuses one beyond it", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-25671-"))
    const origin = mkdtempSync(join(tmpdir(), "yrd-25671-origin-"))
    const git = gitIn(root)
    await git(["init", "--quiet"])
    await git(["init", "--bare", "--quiet", origin])
    await git(["remote", "add", "origin", origin])
    await git(["config", "user.name", "fixture"])
    await git(["config", "user.email", "fixture@yrd.test"])
    const commit = async (name: string, body: string): Promise<string> => {
      writeFileSync(join(root, name), body)
      await git(["add", name])
      await git(["commit", "-m", name, "--quiet"])
      return (await git(["rev-parse", "HEAD"])).trim()
    }
    const sixBehind = await commit("behind", "0\n")
    let oneBehind = sixBehind
    let kept = sixBehind
    for (let step = 1; step <= 6; step++) {
      const sha = await commit(`step-${step}`, `${step}\n`)
      if (step === 5) oneBehind = sha
      kept = sha
    }
    const beyond = await commit("beyond", "beyond\n")
    const keptTree = (await git(["rev-parse", `${kept}^{tree}`])).trim()
    const sameTree = (await git(["commit-tree", keptTree, "-p", sixBehind, "-m", "same tree"])).trim()
    expect((await git(["rev-parse", `${sameTree}^{tree}`])).trim()).toBe(keptTree)
    await git(["update-ref", "refs/heads/lab", sixBehind])
    await git(["push", "--quiet", "origin", "refs/heads/lab:refs/heads/lab"])
    const store = { repo: root, backend: git.backend }
    const location = { ...store, remote: "origin", selection: git.selection }
    const queueTip = await seedEventQueue(location, "lab", sixBehind, new Date("2026-09-22T14:00:00.000Z"))
    const ended = async (branchName: string, tip: string) => {
      const branchRef = `refs/heads/${branchName}`
      await git(["update-ref", branchRef, tip])
      await git(["push", "--quiet", "origin", `${branchRef}:${branchRef}`])
      const chain = await openEvents({ ...location, ref: changesRef("lab", branchName) })
      const opened = await chain.append(
        [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: kept, by: "@dev/2" })],
        { expect: null },
      )
      await chain.append(
        [changeInput("failed", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), reason: "check failed" })],
        { expect: opened.head },
      )
    }
    const retire = (branchName: string, tip: string) =>
      drop(location, { queue: "lab", branch: branchName, by: "@dev/2", note: "25671", retire: { tip } })
    await ended("task/six", sixBehind)
    await expect(retire("task/six", sixBehind)).resolves.toMatchObject({ head: sixBehind })
    await ended("task/one", oneBehind)
    await expect(retire("task/one", oneBehind)).resolves.toMatchObject({ head: oneBehind })
    await ended("task/beyond", beyond)
    await expect(retire("task/beyond", beyond)).rejects.toThrow(new RegExp(`${beyond}.*${kept}.*ancestor of`))
    await ended("task/same", sameTree)
    await expect(retire("task/same", sameTree)).rejects.toThrow(/ancestor of/u)
    expect((await git(["rev-parse", "refs/heads/task/beyond"])).trim()).toBe(beyond)
    expect((await git(["rev-parse", "refs/heads/task/same"])).trim()).toBe(sameTree)
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

  it("refuses branch effect authoring and reads historical facts across branch reuse", async () => {
    const { store, location } = remoteMemStore("yrd-event-run-issue-effect")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const mergeSha = (await target.transact(async (map) => map.set("base", "one"), "base")).oid
    const reusedBranch = await open({ ...store, ref: "refs/heads/task/issue-effect" })
    const reusedSha = (await reusedBranch.transact(async (map) => map.set("work", "reused"), "reuse")).oid
    const queueTip = await seedEventQueue(location, "lab", mergeSha, new Date("2026-09-22T14:00:00.000Z"))
    const ref = changesRef("lab", "task/issue-effect")
    const chain = await openEvents({ ...store, ref })
    const opened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: mergeSha, by: "author" })],
      { expect: null },
    )
    const merged = await chain.append(
      [changeInput("merged", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), commit: mergeSha })],
      { expect: opened.head },
    )
    if (merged.head === null) throw new Error("fixture merged event has no tip")
    const reopened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:03:00.000Z"), commit: reusedSha, by: "author" })],
      { expect: merged.head },
    )
    const verifying = await chain.append(
      [changeInput("verifying", { queueTip, at: new Date("2026-09-22T14:04:00.000Z"), commit: reusedSha })],
      { expect: reopened.head },
    )
    const checking = await chain.append(
      [changeInput("checking", { queueTip, at: new Date("2026-09-22T14:05:00.000Z") })],
      { expect: verifying.head },
    )
    const merging = await chain.append(
      [changeInput("merging", { queueTip, at: new Date("2026-09-22T14:06:00.000Z"), commit: reusedSha })],
      { expect: checking.head },
    )
    const selectedTip = merging.head
    if (selectedTip === null) throw new Error("fixture reused branch has no tip")
    const before = await readStatus(location, "lab", "task/issue-effect")
    const issueKey = "wk/issue/314"
    const providerIdentity = JSON.stringify([mergeSha, "close", "completed", issueKey])
    const effect = {
      ...ISSUE_EFFECT,
      mergedEvent: merged.head,
      mergeSha,
      issueKey,
      providerId: `yrd1-${createHash("sha256").update(providerIdentity).digest("hex")}`,
      declaration: { path: "issues.yml" as const, blob: B },
    }
    // A stale runner must be directed to the common authority before it writes an invisible branch-only fact.
    await expect(
      appendChangeEvent(location, "lab", "task/issue-effect", selectedTip, {
        type: "notified",
        at: new Date("2026-09-22T14:07:00.000Z"),
        issueEffect: effect as never,
        writer: QUEUE_RUN_WRITER,
      }),
    ).rejects.toThrow(/writeQueueEvent/u)
    await expect(
      appendNumberedChangeEvent(
        location,
        "lab",
        "task/issue-effect",
        selectedTip,
        {
          type: "notified",
          at: new Date("2026-09-22T14:07:00.000Z"),
          issueEffect: effect as never,
          writer: QUEUE_RUN_WRITER,
        },
        { id: "retired-writer", startedAt: "2026-09-22T14:07:00.000Z", host: "fixture", actor: "yrd" },
      ),
    ).rejects.toThrow(/writeQueueEvent/u)
    expect(await readStatus(location, "lab", "task/issue-effect")).toEqual(before)
    // Historical facts are fixture data, written through the existing raw event primitive, never the retired API.
    const historical = await openEvents({ ...store, ref, writer: QUEUE_RUN_WRITER })
    const written = (
      await historical.append(
        [
          changeInput("notified", {
            queueTip,
            at: new Date("2026-09-22T14:07:00.000Z"),
            issueEffect: effect,
          }),
        ],
        { expect: selectedTip },
      )
    ).head
    const after = await readStatus(location, "lab", "task/issue-effect")
    expect(after).toEqual({ ...before, tip: written })
    const stored = (await chain.events()).at(-1)
    expect(stored?.props.find(([key]) => key === "Issue-Effect")?.[1]).toBe(JSON.stringify(effect))

    const remoteTip = await chain.head()
    if (remoteTip === null) throw new Error("fixture effect chain lost its tip")
    const historicalEvents = await chain.events()
    expect(() =>
      project(
        changeChain(...historicalEvents, issueEffectEvent({ ...effect, mergedEvent: B }, "d".repeat(40))),
        ref,
        store.repo,
      ),
    ).toThrow(/earlier merged event/u)
    expect(await chain.head()).toBe(remoteTip)
    await expect(
      appendChangeEvent(location, "lab", "task/issue-effect", remoteTip, {
        type: "stuck",
        at: new Date("2026-09-22T14:10:00.000Z"),
        reason: "ordinary runner event",
        writer: QUEUE_RUN_WRITER,
      }),
    ).rejects.toThrow(/reserved for an atomic published merge/u)
    await expect(
      appendChangeEvent(location, "lab", "task/issue-effect", remoteTip, {
        type: "notified",
        at: new Date("2026-09-22T14:11:00.000Z"),
        issueEffect: effect as never,
      }),
    ).rejects.toThrow(/writeQueueEvent/u)
    expect(await chain.head()).toBe(remoteTip)
  })

  it("appends a reverted-paths admission warning and keeps its Warning-Kind through appendChangeEvent (27363)", async () => {
    const { store, location } = remoteMemStore("yrd-event-reverted-paths")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const targetCommit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const queueTip = await seedEventQueue(location, "lab", targetCommit, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await open({ ...store, ref: "refs/heads/task/42" })
    const head = (await branch.transact(async (map) => map.set("work.txt", "one"), "work")).oid
    const ref = changesRef("lab", "task/42")
    const chain = await openEvents({ ...store, ref })
    const opened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head, by: "@dev/2" })],
      { expect: null },
    )
    if (opened.head === null) throw new Error("fixture opened event has no tip")
    const warning = await appendChangeEvent(location, "lab", "task/42", opened.head, {
      type: "admission-warning",
      at: new Date("2026-09-22T14:02:00.000Z"),
      commit: head,
      reason:
        '1 reverted/swallowed path(s): child/a.txt; {"count":1,"coverage":"complete","paths":["child/a.txt"],"swallowed":[]}',
      warningKind: "reverted-paths",
    })
    const stored = (await chain.events()).find((row) => row.id === warning)
    // appendDecision builds the event from ChangeWrite; a dropped Warning-Kind would
    // silently read as "could not judge" instead of the revert detector's finding.
    expect(stored).toMatchObject({ type: "admission-warning" })
    expect(stored?.props.find(([key]) => key === "Warning-Kind")?.[1]).toBe("reverted-paths")
    await expect(
      appendChangeEvent(location, "lab", "task/42", warning, {
        type: "admission-warning",
        at: new Date("2026-09-22T14:03:00.000Z"),
        commit: head,
        reason: "bad kind",
        warningKind: "not-a-kind" as never,
      }),
    ).rejects.toThrow(/Warning-Kind/)
  })

  it("folds the reverted-paths admission kind and keeps folding an old-shape record (27363)", () => {
    const opened = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    // 27363: the revert detector writes this kind. A reader that predates it must
    // fold the record, not refuse it as an unknown Warning-Kind.
    const reverted = evolve(
      opened,
      event(
        "admission-warning",
        B,
        [
          ["Commit", A],
          ["Reason", "1 reverted/swallowed path(s): child/a.txt"],
          ["Warning-Kind", "reverted-paths"],
        ],
        [A],
      ),
    )
    // #28195: kind, event and the raw reason live on the change itself; `diagnostic` keeps the
    // sentences that are not this one.
    expect(reverted.diagnostic).toBeUndefined()
    expect(reverted.admissionWarning).toMatchObject({
      kind: "reverted-paths",
      event: B,
      reason: "1 reverted/swallowed path(s): child/a.txt",
    })

    // Old shape, unchanged: an admission warning with no Warning-Kind still folds.
    const legacyReason = "no kind on the old shape; Next: yrd drop 'literal café'"
    const oldRecord = event(
      "admission-warning",
      B,
      [
        ["Commit", A],
        ["Reason", legacyReason],
      ],
      [A],
    )
    const before = JSON.stringify(oldRecord)
    const old = evolve(opened, oldRecord)
    expect(old.diagnostic).toBe(`admission could not judge ${A.slice(0, 12)}: ${legacyReason}`)
    expect(JSON.stringify(oldRecord)).toBe(before)
    for (const encoded of ["{", "null", '\"\"']) {
      expect(() =>
        evolve(
          opened,
          event(
            "admission-warning",
            B,
            [
              ["Commit", A],
              ["Reason", "target policy output recorded separately"],
              ["Warning-Kind", "policy-warning"],
              ["Admission-Output", encoded],
            ],
            [A],
          ),
        ),
      ).toThrow(new RegExp(`event ${B} has invalid Admission-Output`))
    }
  })

  it("gives a row the reverted-paths finding as a structured notice, counts and all (28195)", () => {
    const opened = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const payload = `0 reverted/swallowed path(s); {"count":0,"counts":{"reverted":0,"swallowed":0,"gaps":684,"unjudged":684,"bounded":0},"coverage":"incomplete","paths":[],"swallowed":[],"gaps":${JSON.stringify(
      Array.from({ length: 32 }, (_, index) => ({
        kind: "unjudged",
        depth: 1,
        reason: "path cap P_max=500",
        path: `content/a${String(index)}.json`,
      })),
    )}}; gaps: path cap P_max=500 [content/a0.json@d1], …`
    const reverted = evolve(
      opened,
      event(
        "admission-warning",
        B,
        [
          ["Commit", A],
          ["Reason", payload],
          ["Warning-Kind", "reverted-paths"],
        ],
        [A],
      ),
    )
    // The fold keeps the reason out of `diagnostic`; the row states the finding from the payload’s own
    // counts, and names the stored gap list as capped rather than counting its prose.
    expect(reverted.diagnostic).toBeUndefined()
    const [row] = eventRows(new Map([["task/reverted", reverted]]))
    expect(row?.diagnostic).toBeUndefined()
    expect(row?.revertWarning).toEqual({
      event: B,
      notice: {
        counts: { reverted: 0, swallowed: 0, gaps: 684, unjudged: 684, bounded: 0 },
        coverage: "incomplete",
        gapsStored: 32,
        truncated: true,
      },
    })
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
    await seedOpsCutover(location, "lab")
    beforeNextPublish(async () => {
      const reason = "raced repair"
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
    ).rejects.toThrow(/needs ops-cutover/)
    const releaseReason = `yrd-stuck-release:${A} repaired`
    // Retirement removes new authoring, while historical event envelopes remain readable.
    await expect(
      writeQueueEvent(location, "lab", {
        type: "paused",
        reason: releaseReason,
        by: "operator",
        at: new Date("2026-09-22T14:00:20.000Z"),
      }),
    ).rejects.toThrow(/needs ops-cutover/)
    const historical = await openEvents({ ...location, ref: queueRef("lab"), writer: "operator" })
    const paused = await historical.append(
      [
        {
          type: "paused",
          props: [
            ["Queue", created],
            ["Time", "2026-09-22T14:00:20.000Z"],
            ["Reason", releaseReason],
          ],
        },
      ],
      { expect: created },
    )
    if (paused.head === null) throw new Error("fixture historical pause has no tip")
    const halfRelease = await readEventQueue(location, "lab")
    expect(halfRelease.tip).toBe(paused.head)
    expect("release" in halfRelease).toBe(false)
    expect(halfRelease.pause).toBeUndefined()
    const resumed = await historical.append(
      [
        {
          type: "resumed",
          props: [
            ["Queue", paused.head],
            ["Time", "2026-09-22T14:00:21.000Z"],
            ["Reason", releaseReason],
          ],
        },
      ],
      { expect: paused.head },
    )
    const beforeCutover = await readEventQueue(location, "lab")
    expect(beforeCutover.tip).toBe(resumed.head)
    expect("release" in beforeCutover).toBe(false)
    expect(beforeCutover.pause).toBeUndefined()
    await seedOpsCutover(location, "lab")
    await writeQueueEvent(location, "lab", {
      type: "paused",
      reason: "repair",
      by: "operator",
      at: new Date("2026-09-22T14:01:00.000Z"),
    })
    expect((await readEventQueue(location, "lab")).ops?.pause?.reason).toBe("repair")
    expect((await readEventQueue(location, "lab")).ops?.pause?.by).toBe("operator")
    await writeQueueEvent(location, "lab", {
      type: "resumed",
      reason: "repaired",
      by: "operator",
      at: new Date("2026-09-22T14:02:00.000Z"),
    })
    expect((await readEventQueue(location, "lab")).ops?.pause).toBeUndefined()
    await expect(
      writeQueueEvent(location, "lab", {
        type: "resumed",
        reason: "again",
        by: "operator",
        at: new Date("2026-09-22T14:03:00.000Z"),
      }),
    ).rejects.toThrow(/queue is not paused/)
  })

  /** @failure A stuck pause loses its named change in the Ops snapshot, so every reader sees a running line.
   * @level l1 @consumer queue list, submit, health, and resume
   */
  it("round-trips a stuck pause with its change through the event Ops snapshot", async () => {
    const { store, location } = remoteMemStore("yrd-event-stuck-ops")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const head = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const queueTip = await seedEventQueue(location, "lab", head, new Date("2026-09-22T14:00:00.000Z"))
    await seedOpsCutover(location, "lab")
    const branch = "task/stuck"
    const opened = await (
      await openEvents({ ...store, ref: changesRef("lab", branch) })
    ).append([changeInput("opened", { queueTip, at: new Date(), commit: head, by: "@dev/2" })], { expect: null })
    if (opened.head === null) throw new Error("fixture opened event has no tip")
    const event = await appendChangeEvent(location, "lab", branch, opened.head, {
      type: "stuck",
      at: new Date(),
      reason: "setup could not reach its remote",
    })
    const change = { branch, head, event }
    const paused = await writeQueueEvent(location, "lab", {
      type: "paused",
      by: "yrd",
      cause: "stuck",
      change,
      reason: "setup could not reach its remote",
      at: new Date("2026-09-22T14:01:00.000Z"),
    })
    expect((await readEventQueue(location, "lab")).ops?.pause).toMatchObject({
      sha: paused,
      by: "yrd",
      cause: "stuck",
      change,
    })
    await writeQueueEvent(location, "lab", {
      type: "resumed",
      by: "@chief",
      reason: "remote repaired",
      at: new Date("2026-09-22T14:02:00.000Z"),
    })
    expect((await readEventQueue(location, "lab")).ops?.pause).toBeUndefined()
  })

  /** @failure A pre-anchor Ops snapshot stored change as a string; retiring that reader strands a paused queue.
   * @level l1 @consumer queue resume during the strict-reader rollout
   */
  it("reads a legacy stuck pause without an event anchor and resumes it", async () => {
    const { store, location } = remoteMemStore("yrd-legacy-stuck-ops")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const head = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const queueTip = await seedEventQueue(location, "lab", head, new Date("2026-09-22T14:00:00.000Z"))
    const branch = "task/legacy-stuck"
    const opened = await (
      await openEvents({ ...store, ref: changesRef("lab", branch) })
    ).append([changeInput("opened", { queueTip, at: new Date(), commit: head, by: "@dev/2" })], { expect: null })
    if (opened.head === null) throw new Error("fixture opened event has no tip")
    await appendChangeEvent(location, "lab", branch, opened.head, {
      type: "stuck",
      at: new Date(),
      reason: "repair needed",
    })
    const cutover = await (
      await openEvents({ ...store, ref: queueRef("lab"), writer: "@chief" })
    ).append(
      [
        {
          type: "ops-cutover",
          props: [
            ["Queue", queueTip],
            ["Time", "2026-09-22T14:00:30.000Z"],
            [
              "Ops",
              JSON.stringify({
                version: 1,
                pause: {
                  kind: "paused",
                  sha: "self",
                  at: "2026-09-22T14:00:20.000Z",
                  reason: "repair needed",
                  by: "yrd",
                  cause: "stuck",
                  change: `${branch}@${head}`,
                },
                overrides: [],
              }),
            ],
          ],
        },
      ],
      { expect: queueTip },
    )
    const knownQueue = await readEventQueue(location, "lab")
    const stop = (await readEventOps(location, gitIn(store.repo), "lab", head, { knownQueue })).stop
    expect(stop).toMatchObject({ sha: cutover.events[0]?.id, change: { branch, head } })
    await writeQueueEvent(location, "lab", {
      type: "resumed",
      by: "@chief",
      reason: "repaired",
      at: new Date("2026-09-22T14:01:00.000Z"),
    })
    expect((await readEventOps(location, gitIn(store.repo), "lab", head)).stop).toBeUndefined()
    // Reusing queue ops must not freeze the stuck-stop conclusion when only its change advances.
    const change = await openEvents({ ...store, ref: changesRef("lab", branch) })
    const stuckTip = await change.head()
    if (stuckTip === null) throw new Error("fixture stuck change is absent")
    await writeQueueEvent(location, "lab", {
      type: "paused",
      by: "@chief",
      reason: "stuck again",
      cause: "stuck",
      change: { branch, head, event: stuckTip },
      at: new Date(),
    })
    const paused = await readEventQueue(location, "lab")
    expect((await readEventOps(location, gitIn(store.repo), "lab", head, { knownQueue: paused })).stop).toMatchObject({
      cause: "stuck",
      change: { branch, head },
    })
    await appendChangeEvent(location, "lab", branch, stuckTip, {
      type: "cancelled",
      at: new Date(),
      commit: head,
      reason: "dropped",
    })
    expect((await readEventOps(location, gitIn(store.repo), "lab", head, { knownQueue: paused })).stop).toBeUndefined()
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
    const earlier = `yrd-stuck-release:${A} earlier repair`
    await seedHistoricalRelease(location, "lab", "paused", earlier)
    await seedHistoricalRelease(location, "lab", "resumed", earlier)
    const stuck = await appendChangeEvent(location, "lab", branch, opened.head, {
      type: "stuck",
      at: new Date(),
      reason: "repair needed",
    })
    const history = (await readEventQueueWithChanges(location, "lab")).histories.get(branch)
    expect(await queueResumedAfter(location, "lab", branch, history)).toBe(false)
    const reason = `yrd-stuck-release:${stuck} repaired`
    await seedHistoricalRelease(location, "lab", "paused", reason)
    expect(await queueResumedAfter(location, "lab", branch, history)).toBe(false)
    await seedHistoricalRelease(location, "lab", "resumed", reason)
    expect(await queueResumedAfter(location, "lab", branch, history)).toBe(true)
  })

  it("refuses ops cutover while a stuck release is unfinished", async () => {
    const { store, location } = remoteMemStore("yrd-unfinished-release-cutover")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date())
    await seedHistoricalRelease(location, "lab", "paused", `yrd-stuck-release:${A} repair`)
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
    expect((await readEventQueue(location, "lab")).ops?.pause).toBeUndefined()
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
        expect((await readEventQueue(location, "lab")).pause).toMatchObject({
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
    expect((await readEventQueue(location, "lab")).ops?.pause).toMatchObject({ cause: "maintenance", by: "@chief" })
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

  /** @failure A snapshot names one check twice, making its override ambiguous (25041 A9).
   * @level l1 @consumer queue operator and merge runner
   */
  it("refuses duplicate override checks in an ops snapshot", async () => {
    const { store, location } = remoteMemStore("yrd-event-duplicate-override-check")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const at = new Date("2026-09-22T14:01:00.000Z")
    const entry: OpsState["overrides"][number] = {
      check: "build",
      state: "active",
      until: new Date("2026-09-22T15:00:00.000Z"),
      by: "operator",
      verified: true,
      reason: "repair",
      record: A,
      setAt: at,
    }
    await seedOpsCutover(location, "lab", { overrides: [entry, entry] })

    await expect(readEventQueue(location, "lab")).rejects.toThrow(/duplicate override check/)
  })

  /** @failure An override for one check silently changes another check's standing decision (25041 A8).
   * @level l1 @consumer queue operator and merge runner
   */
  it("refuses an override event that changes another check", async () => {
    const { store, location } = remoteMemStore("yrd-event-override-other-check")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    await seedOpsCutover(location, "lab")
    await writeQueueOverride(
      location,
      "lab",
      {
        kind: "off",
        check: "lint",
        until: new Date("2026-09-22T15:00:00.000Z"),
        reason: "lint repair",
        actor: { by: "operator", verified: true },
      },
      ["lint", "build"],
      new Date("2026-09-22T14:01:00.000Z"),
    )
    const queue = await readEventQueue(location, "lab")
    const lint = queue.ops?.overrides.find((entry) => entry.check === "lint")
    if (lint === undefined) throw new Error("fixture lint override was not written")
    const at = new Date("2026-09-22T14:02:00.000Z")
    const until = new Date("2026-09-22T16:00:00.000Z")
    await (
      await openEvents({ ...store, ref: queueRef("lab"), writer: "operator" })
    ).append(
      [
        {
          type: "override-set",
          props: [
            ["Queue", queue.tip],
            ["Time", at.toISOString()],
            ["Check", "build"],
            ["Reason", "build repair"],
            ["Until", until.toISOString()],
            [
              "Ops",
              encodeOps({
                overrides: [
                  { ...lint, reason: "silently changed" },
                  {
                    check: "build",
                    state: "active",
                    until,
                    by: "operator",
                    verified: true,
                    reason: "build repair",
                    record: "self",
                    setAt: at,
                  },
                ],
              }),
            ],
          ],
        },
      ],
      { expect: queue.tip },
    )
    await expect(readEventQueue(location, "lab")).rejects.toThrow(/changed another check/)
  })

  /** @failure A merge fence changed the queue's effective ops without an operator action (25041 A4).
   * @level l1 @consumer queue operator and merge runner
   */
  it("refuses a merge fence that introduces a pause", async () => {
    const { store, location } = remoteMemStore("yrd-event-merge-fence-ops")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const created = await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const cutover = await seedOpsCutover(location, "lab")
    await (
      await openEvents({ ...store, ref: queueRef("lab"), writer: QUEUE_RUN_WRITER })
    ).append(
      [
        {
          type: "merge-fenced",
          keeps: [created],
          props: [
            ["Queue", cutover],
            ["Time", "2026-09-22T14:01:00.000Z"],
            ["For", created],
            ["Branch", "task/fenced"],
            ["Commit", commit],
            [
              "Ops",
              encodeOps({
                pause: {
                  kind: "paused",
                  sha: "self",
                  at: new Date("2026-09-22T14:01:00.000Z"),
                  reason: "inserted by merge fence",
                  by: "operator",
                  cause: "operator",
                },
                overrides: [],
              }),
            ],
          ],
        },
      ],
      { expect: cutover },
    )

    await expect(readEventQueue(location, "lab")).rejects.toThrow(/merge-fenced.*changed effective ops state/)
  })

  /** @failure A merge fence whose Ops: text differs from the held state by one byte is taken for a repeat and not
   * decoded, so a changed override enters the queue's effective ops unrefused (28925: only byte-identical text skips).
   * @level l1 @consumer queue operator and merge runner
   */
  it("decodes a merge fence whose Ops: differ from the held state by one byte, and refuses the change", async () => {
    const { store, location } = remoteMemStore("yrd-event-merge-fence-one-byte")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const created = await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const held: OpsState = {
      overrides: [
        {
          check: "build",
          state: "active",
          until: new Date("2026-09-22T15:00:00.000Z"),
          by: "operator",
          verified: true,
          reason: "repair",
          record: A,
          setAt: new Date("2026-09-22T14:00:00.000Z"),
        },
      ],
    }
    const cutover = await seedOpsCutover(location, "lab", held)
    const text = encodeOps(held)
    const changed = text.replace('"reason":"repair"', '"reason":"repaid"')
    expect([changed.length, changed === text]).toEqual([text.length, false])
    await (
      await openEvents({ ...store, ref: queueRef("lab"), writer: QUEUE_RUN_WRITER })
    ).append(
      [
        {
          type: "merge-fenced",
          keeps: [created],
          props: [
            ["Queue", cutover],
            ["Time", "2026-09-22T14:01:00.000Z"],
            ["For", created],
            ["Branch", "task/fenced"],
            ["Commit", commit],
            ["Ops", changed],
          ],
        },
      ],
      { expect: cutover },
    )

    await expect(readEventQueue(location, "lab")).rejects.toThrow(/merge-fenced.*changed effective ops state/)
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

  // @failure Per-round fetch refs leaked into the immutable local anchor reader and stopped the live queue.
  // @level l2 @consumer Queue service read policy @testonly none
  it("reads an empty completion map with per-round remote fetch refs", async () => {
    const { store, location } = remoteMemStore("yrd-queue-anchor-fetch-policy")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set("work", "one"), "work")).oid
    const tip = await seedEventQueue(location, "lab", commit, new Date())
    await activateRunIndex(location, "lab", new Date())
    const acquired = queueReadWithRunIndex(location, "lab").store
    expect(await readEventQueue(acquired, "lab")).toMatchObject({ tip, issueEffects: {} })
  })

  // A queue completion must be readable from any branch replay without walking other
  // branches. These cases exercise the retained immutable anchor and its queue authority.
  it.each([
    "valid",
    "unkept",
    "wrong merge",
    "not merged",
    "foreign queue",
    "wrong writer",
    "duplicate",
    "reuse same",
    "reuse descendant",
    "reuse rewrite",
  ])("reads retained issue effects on the queue chain: %s", async (variant) => {
    const { store, location: remoteLocation } = remoteMemStore(`yrd-queue-issue-effect-${variant}`)
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const at = new Date("2026-09-22T14:00:00.000Z")
    const queueTip = await seedEventQueue(remoteLocation, "lab", commit, at)
    await activateRunIndex(remoteLocation, "lab", at)
    const location = queueReadWithRunIndex(remoteLocation, "lab").store
    const branch = await openEvents({ ...store, ref: changesRef("lab", "task/retained"), writer: QUEUE_RUN_WRITER })
    const opened = await branch.append([changeInput("opened", { queueTip, at, commit, by: "author" })], {
      expect: null,
    })
    const merged = await branch.append(
      [changeInput("merged", { queueTip: variant === "foreign queue" ? B : queueTip, at, commit })],
      { expect: opened.head },
    )
    const anchor = variant === "not merged" ? opened.head : merged.head
    if (anchor === null) throw new Error("fixture lacks its retained event")
    const mergeSha = variant === "wrong merge" ? A : commit
    const effect = {
      ...ISSUE_EFFECT,
      mergedEvent: anchor,
      mergeSha,
      providerId: `yrd1-${createHash("sha256")
        .update(JSON.stringify([mergeSha, "close", "completed", ISSUE_EFFECT.issueKey]))
        .digest("hex")}`,
    }
    const queue = await openEvents({
      ...store,
      ref: queueRef("lab"),
      writer: variant === "wrong writer" ? "intruder" : QUEUE_RUN_WRITER,
    })
    const input: EventInput = {
      type: "notified",
      props: [
        ["Queue", queueTip],
        ["Time", at.toISOString()],
        ["Issue-Effect", JSON.stringify(effect)],
      ],
      keeps: variant === "unkept" ? [] : [anchor],
    }
    const written = await queue.append([input], { expect: queueTip })
    const duplicatePrefix = variant === "duplicate" ? await readEventQueue(location, "lab") : undefined
    if (variant === "duplicate") {
      await queue.append(
        [
          {
            ...input,
            props: input.props?.map(([key, value]) => [key, key === "Queue" ? (written.head as string) : value]),
          },
        ],
        { expect: written.head },
      )
    }
    if (variant !== "valid" && !variant.startsWith("reuse ")) {
      const failures: Record<string, RegExp> = {
        unkept: /keep.*merged event/u,
        "wrong merge": /mergeSha.*merged event/u,
        "not merged": /actual merged event/u,
        "foreign queue": /queue cause/u,
        "wrong writer": /writer yrd-run/u,
        duplicate: /duplicate issue effect/u,
      }
      await expect(readEventQueue(location, "lab", { knownQueue: duplicatePrefix })).rejects.toThrow(failures[variant])
      return
    }
    const reading = await readEventQueue(location, "lab")
    expect(reading.issueEffects[effect.providerId]).toEqual({ id: written.head, effect })
    expect(reading.notices).toEqual({})
    if (variant.startsWith("reuse ")) {
      // Reuse saves immutable anchor reads, while rewrites must validate every surviving fact again.
      let knownQueue = reading
      if (variant === "reuse descendant") {
        const later = await branch.append([changeInput("merged", { queueTip: written.head!, at, commit })], {
          expect: anchor,
        })
        const issueKey = "wk/issue/new-anchor"
        await writeQueueEvent(location, "lab", {
          type: "notified",
          by: QUEUE_RUN_WRITER,
          at,
          issueEffect: {
            ...effect,
            mergedEvent: later.head!,
            issueKey,
            providerId: `yrd1-${createHash("sha256")
              .update(JSON.stringify([mergeSha, "close", "completed", issueKey]))
              .digest("hex")}`,
          },
        })
      } else if (variant === "reuse rewrite") {
        const extra = await writeQueueEvent(location, "lab", { type: "observed", by: QUEUE_RUN_WRITER, at, commit })
        knownQueue = await readEventQueue(location, "lab")
        if (store.backend.publish === undefined) throw new Error("fixture lacks queue rewrite publisher")
        await store.backend.publish(store.repo, [{ ref: queueRef("lab"), expect: extra, oid: written.head! }], "origin")
      }
      const histories = vi.spyOn(location.backend, "readHistory")
      try {
        const current = await readEventQueue(location, "lab", { knownQueue })
        expect(Object.keys(current.issueEffects)).toHaveLength(variant === "reuse descendant" ? 2 : 1)
        // One first-parent queue read, plus zero old anchors / one new anchor / one rewritten anchor.
        expect(histories).toHaveBeenCalledTimes(variant === "reuse same" ? 1 : 2)
      } finally {
        histories.mockRestore()
      }
      return
    }
    expect((await queue.events()).map((event) => event.type)).toEqual(["created", "notified"])
    // The sole completion writer must dedupe an existing fact and retain a new anchor through its queue CAS.
    expect(
      await writeQueueEvent(location, "lab", { type: "notified", by: QUEUE_RUN_WRITER, at, issueEffect: effect }),
    ).toBe(written.head)
    const issueKey = "wk/issue/another"
    const next = {
      ...effect,
      issueKey,
      providerId: `yrd1-${createHash("sha256")
        .update(JSON.stringify([mergeSha, "close", "completed", issueKey]))
        .digest("hex")}`,
    }
    const applied = await writeQueueEvent(location, "lab", {
      type: "notified",
      by: QUEUE_RUN_WRITER,
      at,
      issueEffect: next,
    })
    expect((await readEventQueue(location, "lab")).issueEffects[next.providerId]).toEqual({
      id: applied,
      effect: next,
    })
    expect((await queue.events()).at(-1)?.links).toEqual([anchor])
  })

  const GITHUB_5XX = [
    "remote: Internal Server Error",
    "fatal: unable to access 'https://github.com/beorn/hh.git/': The requested URL returned error: 500",
    "remote: Request ID: 8B8E:93E9C:1C9E26:269104:6AC672BE",
  ].join("\n")

  function stubTransientBackoff(): () => void {
    const sleep = transientPushRetry.sleep
    transientPushRetry.sleep = async () => {}
    return () => {
      transientPushRetry.sleep = sleep
    }
  }

  function silenceStderr(): () => void {
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      if (typeof encoding === "function") encoding()
      if (typeof callback === "function") callback()
      return true
    }) as typeof process.stderr.write
    return () => {
      process.stderr.write = write
    }
  }

  /** @failure 28805, @cto: writeQueueEvent published its queue event with a bare
   * `chain.transact`, so a 500 that arrived AFTER the push landed threw and the
   * reader could not tell "the event did not land" from "the answer is unknown" —
   * a re-run then appends a SECOND event. Through the one funnel the landed probe
   * returns the staged event and the chain carries exactly one append.
   * @level l1 @consumer every yrd CLI and runner that writes a queue event
   */
  it("lands exactly one queue event when the 500 arrives after the push landed", async () => {
    const { store, location, afterNextPublish } = remoteMemStore("yrd-queue-event-5xx-landed")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const restoreSleep = stubTransientBackoff()
    const restoreStderr = silenceStderr()
    try {
      let publishes = 0
      afterNextPublish(async (updates) => {
        publishes++
        // The push APPLIED (this hook runs after the ref moved); the 500 rides the response.
        throw new PublicationRejected(updates, [GITHUB_5XX], GITHUB_5XX)
      })
      const written = await writeQueueEvent(location, "lab", {
        type: "observed",
        commit,
        branch: "task/direct",
        by: "yrd-run",
        at: new Date("2026-09-22T14:01:00.000Z"),
      })
      const events = await (await openEvents({ ...location, ref: queueRef("lab") })).events()
      expect(events.map((event) => event.type)).toEqual(["created", "observed"])
      expect(events.at(-1)?.id).toBe(written)
      expect(publishes).toBe(1)
    } finally {
      restoreStderr()
      restoreSleep()
    }
  })

  /** @failure 28805 addition 1, @cto: exhaustion is the CALLER's decision. A queue
   * event whose push never lands must surface the ORIGINAL 5xx from
   * writeQueueEvent — recognizable by the caller's own probe — not be swallowed or
   * turned into a second append.
   * @level l1 @consumer every yrd CLI and runner that writes a queue event
   */
  it("surfaces an exhausted queue-event 5xx for the caller to decide", async () => {
    const { store, location } = remoteMemStore("yrd-queue-event-5xx-exhausted")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const restoreSleep = stubTransientBackoff()
    const restoreStderr = silenceStderr()
    try {
      let publishes = 0
      using _never = vi.spyOn(store.backend, "publish").mockImplementation(async () => {
        publishes++
        throw new PublicationRejected([], [GITHUB_5XX], GITHUB_5XX)
      })
      const failure = await writeQueueEvent(location, "lab", {
        type: "observed",
        commit,
        branch: "task/direct",
        by: "yrd-run",
        at: new Date("2026-09-22T14:01:00.000Z"),
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      // The caller maps the exhaustion itself: the original 5xx is still recognizable.
      expect(transientPush5xxOf(failure)).toMatchObject({
        line: expect.stringContaining("Internal Server Error"),
        requestId: "8B8E:93E9C:1C9E26:269104:6AC672BE",
      })
      expect(publishes).toBe(transientPushRetry.attempts)
      const events = await (await openEvents({ ...location, ref: queueRef("lab") })).events()
      expect(events.map((event) => event.type)).toEqual(["created"])
    } finally {
      restoreStderr()
      restoreSleep()
    }
  })

  it("records one notify-floors snapshot, dedups a replay, and refuses a malformed one loudly", async () => {
    const { store, location } = remoteMemStore("yrd-event-notify-floors")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const endingId = "a".repeat(40)
    const notBefore = new Date("2026-09-22T14:00:00.000Z")

    const written = await writeQueueEvent(location, "lab", {
      type: "notify-floors",
      by: "yrd-run",
      at: new Date("2026-09-22T14:01:00.000Z"),
      floors: { recorder: { notBefore, present: [endingId] } },
    })
    expect((await readEventQueue(location, "lab")).notifyFloors).toEqual({
      recorder: { notBefore, present: new Set([endingId]) },
    })
    // A byte-identical rewrite folds to the same tip: one snapshot, not a second event.
    expect(
      await writeQueueEvent(location, "lab", {
        type: "notify-floors",
        by: "yrd-run",
        at: new Date("2026-09-22T14:02:00.000Z"),
        floors: { recorder: { notBefore, present: [endingId] } },
      }),
    ).toBe(written)

    // A malformed snapshot must fail loud rather than read as "no floors".
    const chain = await openEvents({ ...location, ref: queueRef("lab"), writer: "yrd-run" })
    const tip = (await readEventQueue(location, "lab")).tip
    await chain.append(
      [
        {
          type: "notify-floors",
          props: [
            ["Queue", tip],
            ["Time", "2026-09-22T14:03:00.000Z"],
            ["Floors", "{not json"],
          ],
        },
      ],
      { expect: tip },
    )
    await expect(readEventQueue(location, "lab")).rejects.toThrow(/notify-floors.*unreadable Floors/)
  })

  /** @failure 27198: a malformed notify-floors instant threw a raw RangeError, and a non-canonical or repeated present id read as an empty set.
   * @level l0 @consumer queue reader
   */
  it("refuses a notify-floors snapshot with a bad instant, a non-canonical id, or a repeat", async () => {
    const ending = "a".repeat(40)
    const bad: readonly string[] = [
      '{"recorder":{"notBefore":"not-a-date","present":[]}}',
      '{"recorder":{"notBefore":"2026-09-22T14:00:00.000Z","present":["zz"]}}',
      `{"recorder":{"notBefore":"2026-09-22T14:00:00.000Z","present":["${ending}","${ending}"]}}`,
    ]
    for (const [index, floors] of bad.entries()) {
      const { store, location } = remoteMemStore(`yrd-event-notify-floors-bad-${String(index)}`)
      const target = await open({ ...store, ref: "refs/heads/lab" })
      const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
      await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
      const chain = await openEvents({ ...location, ref: queueRef("lab"), writer: "yrd-run" })
      const tip = (await readEventQueue(location, "lab")).tip
      await chain.append(
        [
          {
            type: "notify-floors",
            props: [
              ["Queue", tip],
              ["Time", "2026-09-22T14:03:00.000Z"],
              ["Floors", floors],
            ],
          },
        ],
        { expect: tip },
      )
      await expect(readEventQueue(location, "lab")).rejects.toThrow(/notify-floors event/)
    }
  })

  /** @failure 27198: a `__proto__` notify name silently changed the floors record's prototype and dropped the entry.
   * @level l0 @consumer queue reader
   */
  it("keeps a __proto__ notify name as a real floors entry", async () => {
    const { store, location } = remoteMemStore("yrd-event-notify-floors-proto")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const ending = "a".repeat(40)
    const floors = Object.create(null) as Record<string, { notBefore: Date; present: readonly string[] }>
    floors["__proto__"] = { notBefore: new Date("2026-09-22T14:00:00.000Z"), present: [ending] }
    await writeQueueEvent(location, "lab", {
      type: "notify-floors",
      by: "yrd-run",
      at: new Date("2026-09-22T14:01:00.000Z"),
      floors,
    })
    const read = (await readEventQueue(location, "lab")).notifyFloors
    expect(Object.keys(read ?? {})).toEqual(["__proto__"])
    expect(read?.["__proto__"]?.present.has(ending)).toBe(true)
  })

  it("refuses to classify empty when listing the queue prefix fails (26398)", async () => {
    const { location } = remoteMemStore("yrd-listing-failure")
    const broken = {
      ...location,
      backend: {
        ...location.backend,
        listRefs: async () => {
          throw new Error("ls-remote failed: origin unreadable")
        },
      },
    }
    await expect(queueFormat(broken, "lab")).rejects.toThrow(/ls-remote failed: origin unreadable/)
  })

  it("selects one event queue by its queue ref and reads an empty change set without legacy fallback", async () => {
    const { store, location } = remoteMemStore("yrd-event-selector")
    expect(await queueFormat(location, "lab")).toBe("empty")
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

  /** @failure A retained tip makes hot/cold history unreadable or loses the extra commit parent.
   * @level l1 @consumer selected change history, list and detail readers
   * Existing custody fixtures have no retained event and cannot expose an old-reader diagnostic.
   */
  it.each(["hot", "cold"] as const)("30432: reads retained custody through the %s event ref", async (custody) => {
    const { store, location } = remoteMemStore(`yrd-retained-${custody}`)
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const head = (await target.transact(async (map) => map.set("work.txt", "merged"), "merged work")).oid
    const extra = (await target.transact(async (map) => map.set("extra.txt", "unmerged"), "extra head")).oid
    const at = new Date("2026-09-22T14:00:00.000Z")
    const queueTip = await seedEventQueue(location, "lab", head, at)
    const branch = "task/retained"
    const hotRef = changesRef("lab", branch)
    const selectedRef = custody === "hot" ? hotRef : `refs/yrd-archive/lab/${branch}`
    const chain = await openEvents({ ...store, ref: hotRef })
    await chain.append(
      [
        changeInput("opened", { queueTip, at, commit: head, by: "@dev/3" }),
        changeInput("merged", { queueTip, at, commit: head }),
      ],
      { expect: null },
    )
    const before = await readStatus(location, "lab", branch)
    if (custody === "cold") {
      await store.backend.publish!(
        store.repo,
        [
          { ref: selectedRef, expect: "0".repeat(40), oid: before.tip! },
          { ref: hotRef, expect: before.tip!, oid: null },
        ],
        "origin",
      )
    }
    const selected = await readBranchHistory(location, "lab", branch)
    expect(selected.ref).toBe(selectedRef)
    const write = changeInput("retained", {
      queueTip,
      at: new Date("2026-10-20T12:00:00.000Z"),
      commit: extra,
      by: "@dev/3",
      reason: "keep extra head before retirement",
    })
    const retained = await (
      await openEvents({ ...store, ref: selected.ref })
    ).append(decide(selected.history!.events, write), { expect: before.tip! })
    const tip = retained.events[0]!.id
    const reread = await readBranchHistory(location, "lab", branch)
    expect(reread.ref).toBe(selectedRef)
    expect(reread.history?.events.at(-1)?.links).toContain(extra)
    expect(reread.history?.state).toEqual({ ...before, tip })
    expect(await readStatus(location, "lab", branch)).toEqual({ ...before, tip })
    expect((await listChanges(location, "lab")).get(branch)).toEqual({ ...before, tip })
  })

  /** @failure 27957: moving an ended chain outside the hot prefix hides its merge and history from list/detail.
   * @level l1 @consumer yrd list, queue show and selected change history
   * Existing history tests retain every chain under changes/ and cannot detect cold-custody disappearance.
   */
  it("keeps a cold merged branch discoverable with its original events and merge evidence", async () => {
    const { store, location } = remoteMemStore("yrd-cold-change-history")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const head = (await target.transact(async (map) => map.set("work.txt", "retained payload"), "work")).oid
    const at = new Date("2026-09-22T14:00:00.000Z")
    const queueTip = await seedEventQueue(location, "lab", head, at)
    const branch = "task/retained"
    const hotRef = changesRef("lab", branch)
    const coldRef = `refs/yrd-archive/lab/${branch}`
    const chain = await openEvents({ ...store, ref: hotRef })
    const written = await chain.append(
      [
        changeInput("opened", { queueTip, at, commit: head, by: "@dev/6" }),
        changeInput("merged", { queueTip, at, commit: head }),
      ],
      { expect: null },
    )
    let tip = written.events.at(-1)!.id
    // @failure 27957: the archival audit is state-neutral, including the original ending age/notices.
    // Unknown-event tolerance adds a diagnostic and cannot supply the required audit contract.
    const beforeArchive = await readStatus(location, "lab", branch)
    // A reader validates audit consistency independently of the writer's retention policy.
    for (const archivedAt of [new Date("2026-10-07T12:00:00.000Z"), new Date(at.getTime() + 86_400_000)]) {
      expect(
        evolve(
          beforeArchive,
          event("archived", B, [
            ["Queue", queueTip],
            ["Time", archivedAt.toISOString()],
            ["Archive-Ref", hotRef],
            ["Archive-Tip", tip],
            ["Archive-State", "merged"],
            ["Archive-EndedAt", at.toISOString()],
            ["Archive-AgeMs", String(archivedAt.getTime() - at.getTime())],
          ]),
        ),
      ).toEqual({ ...beforeArchive, tip: B })
    }
    expect((await listChanges(location, "lab")).get(branch)).toMatchObject({ status: "merged", merge: head })
    await store.backend.publish!(
      store.repo,
      [
        { ref: coldRef, expect: "0".repeat(40), oid: tip },
        { ref: hotRef, expect: tip, oid: null },
      ],
      "origin",
    )
    expect((await listRefs(hotRef, location)).size).toBe(0)
    expect((await listRefs(coldRef, location)).get(coldRef)).toBe(tip)
    expect((await listChanges(location, "lab")).get(branch)).toMatchObject({ status: "merged", merge: head, tip })
    expect((await readEventQueueWithChanges(location, "lab")).histories.get(branch)?.state.merge).toBe(head)
    expect(await readStatus(location, "lab", branch)).toMatchObject({ status: "merged", merge: head, tip })
    expect((await readChangeEvents(location, "lab", branch, tip)).map((row) => row.id)).toEqual(
      written.events.map((row) => row.id),
    )
    // @failure 27957: a late notification must append to cold custody without recreating its hot ref.
    // Existing notification cases only write to hot chains; preserve the original ending/time here.
    const ending = tip
    const key = `${ending}:operator`
    tip = await appendChangeEvent(location, "lab", branch, tip, {
      type: "notified",
      at: new Date("2026-10-07T12:00:00.000Z"),
      notice: { for: ending, to: "operator", key, result: "delivered" },
    })
    expect((await listRefs(hotRef, location)).size).toBe(0)
    expect((await listRefs(coldRef, location)).get(coldRef)).toBe(tip)
    expect(await readStatus(location, "lab", branch)).toMatchObject({
      status: "merged",
      merge: head,
      endedAt: at,
      ending: { id: ending },
      notices: { [key]: { for: ending, result: "delivered" } },
    })
    // A custody move after advertisement must report a changed reading, never an empty successful list.
    // Existing static-history coverage cannot exercise the advertisement/acquisition boundary.
    const fetch = location.backend.fetchRefs
    if (fetch === undefined) throw new Error("fixture backend lacks remote acquisition")
    let moved = false
    const moving = {
      ...location,
      backend: {
        ...location.backend,
        fetchRefs: async (...args: Parameters<typeof fetch>) => {
          const requested = args[1]
          if (!moved && Array.isArray(requested) && requested.includes(coldRef)) {
            moved = true
            await store.backend.publish!(
              store.repo,
              [
                { ref: hotRef, expect: "0".repeat(40), oid: tip },
                { ref: coldRef, expect: tip, oid: null },
              ],
              "origin",
            )
          }
          return fetch(...args)
        },
      },
    }
    // 29386: the reader re-acquires a moved inventory in-round, so one move recovers into a
    // correct reading instead of refusing; only exhaustion past the bound is a loud failure.
    const recovered = await listChanges(moving, "lab")
    expect(recovered.get(branch)).toMatchObject({ status: "merged", merge: head, tip })
    expect(moved).toBe(true)
    expect((await listChanges(location, "lab")).get(branch)).toMatchObject({ status: "merged", merge: head, tip })
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
    // Ops reuse has the same identity contract; fresh-ops tests never pass a projection.
    for (const [location, name, knownQueue] of [
      [second.location, "lab", queue],
      [{ ...first.location, remote: "elsewhere" }, "lab", queue],
      [{ ...first.location, backend: { ...first.location.backend } }, "lab", queue],
      [first.location, "other", queue],
      [first.location, "lab", { ...queue }],
    ] as const) {
      await expect(readEventOps(location, gitIn(first.store.repo), name, commit, { knownQueue })).rejects.toThrow(
        /validated queue.*same location/,
      )
      await expect(readEventQueue(location, name, { knownQueue })).rejects.toThrow(/validated queue.*same location/)
      await expect(readEventQueueWithChain(location, name, { knownQueue })).rejects.toThrow(
        /validated queue.*same location/,
      )
    }
    expect(await listChangeHistories(first.location, "lab")).toEqual({ histories: new Map(), invalid: new Map() })
  })

  /** @failure A listing decodes the same queue history twice; reuse must still acquire fresh authority.
   * @level l1 @consumer yrd list's final operational reading (28925 AC2/AC3)
   * Existing fresh-ops tests do not exercise reuse or count queue-history decoding.
   */
  it("reuses a stable queue decode and reads the newly acquired tip after an advance", async () => {
    const { store, location } = remoteMemStore("yrd-ops-reuse")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const head = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", head, new Date("2026-09-22T14:00:00.000Z"))
    await seedOpsCutover(location, "lab")
    const histories = vi.spyOn(location.backend, "readHistory")
    const knownQueue = await readEventQueue(location, "lab")
    const reused = await readEventOps(location, gitIn(store.repo), "lab", head, { knownQueue })
    expect(reused).toMatchObject({ queue: { tip: knownQueue.tip }, overrides: { entries: [] } })
    expect(histories).toHaveBeenCalledTimes(1)
    await readEventOps(location, gitIn(store.repo), "lab", head)
    expect(histories).toHaveBeenCalledTimes(2)
    const local = { ...store, selection: location.selection }
    const localQueue = await readEventQueue(local, "lab")
    histories.mockClear()
    expect((await readEventOps(local, gitIn(store.repo), "lab", head, { knownQueue: localQueue })).queue.tip).toBe(
      localQueue.tip,
    )
    expect(histories).not.toHaveBeenCalled()
    const current = await writeQueueEvent(location, "lab", {
      type: "paused",
      by: "@chief",
      reason: "new maintenance",
      cause: "maintenance",
      at: new Date("2026-09-22T14:01:00.000Z"),
    })
    expect(current).not.toBe(knownQueue.tip)
    const advanced = await readEventOps(location, gitIn(store.repo), "lab", head, { knownQueue })
    expect(advanced).toMatchObject({
      queue: { tip: current },
      stop: { cause: "maintenance", reason: "new maintenance" },
    })
    histories.mockRestore()
  })

  /** @failure Reuse trusts an earlier leased ref inventory or falls back after final acquisition fails.
   * @level l1 @consumer yrd list's final operational reading (28925 AC3)
   * Submit's existing legacy-ref tests use fresh ops rather than a known projection.
   */
  it("revalidates legacy absence and acquisition failures even with reused ops and listed refs", async () => {
    const { store, location } = remoteMemStore("yrd-ops-reuse-fence")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const head = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    await seedEventQueue(location, "lab", head, new Date("2026-09-22T14:00:00.000Z"))
    await seedOpsCutover(location, "lab")
    const knownQueue = await readEventQueue(location, "lab")
    const listed = { refs: await listRefs("refs/", location) }
    const legacy = await openEvents({ ...store, ref: pauseRef("lab") })
    await legacy.append([input("paused")], { expect: null })
    await expect(
      readEventOpsWithRefs(location, gitIn(store.repo), "lab", head, listed, { knownQueue }),
    ).rejects.toThrow(/retired legacy pause ref refs\/yrd\/lab\/pause/)
    const fetch = vi.spyOn(location.backend, "fetchRefs").mockRejectedValue(new Error("final acquisition failed"))
    await expect(
      readEventOpsWithRefs(location, gitIn(store.repo), "lab", head, listed, { knownQueue }),
    ).rejects.toThrow(/could not fetch queue.*final acquisition failed/)
    fetch.mockRestore()
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

  // @failure 29386: the fresh re-inventory lived only in the CLI listing, so the queue run's own
  //          multi-prefix reader failed a round on a race it could have re-read in place.
  // @level l1 @consumer queue list acquisition and the queue run (listChangeHistories)
  it("re-inventories a moved multi-prefix selection in the reader itself, bounded and typed", async () => {
    for (const [moves, outcome] of [
      [3, "recovers"],
      [8, "exhausts"],
    ] as const) {
      const { store, location } = remoteMemStore(`yrd-bounded-reinventory-${outcome}`)
      const target = await open({ ...store, ref: "refs/heads/lab" })
      const head = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
      const queueTip = await seedEventQueue(location, "lab", head, new Date("2026-09-22T14:00:00.000Z"))
      const branch = "task/moving"
      const ref = changesRef("lab", branch)
      await (
        await openEvents({ ...store, ref })
      ).append([changeInput("opened", { queueTip, at: new Date(), commit: head, by: "@dev/2" })], { expect: null })
      const original = location.backend.fetchRefs
      if (original === undefined) throw new Error("fixture needs a fetch-capable backend")
      let seen = 0
      // The selected ref keeps advancing inside EVERY advertisement-to-fetch window until the budget
      // runs out, so the reader's own re-inventory is the only thing that can make the two agree.
      location.backend = {
        ...location.backend,
        fetchRefs: async (...args: Parameters<typeof original>) => {
          const [, refs] = args
          if (seen < moves && typeof refs !== "string" && refs.includes(ref)) {
            seen++
            const moved = await openEvents({ ...store, ref })
            const tip = await moved.head()
            await moved.append(
              [
                changeInput("verifying", {
                  queueTip,
                  at: new Date(Date.parse("2026-09-22T14:00:00.000Z") + seen * 1_000),
                  commit: head,
                }),
              ],
              { expect: tip },
            )
          }
          return original(...args)
        },
      }
      let readError: unknown
      let histories: readonly string[] = []
      try {
        histories = [...(await readEventQueueWithChanges(location, "lab")).histories.keys()]
      } catch (error) {
        readError = error
      }
      expect(seen).toBe(moves)
      if (outcome === "recovers") {
        expect(readError).toBeUndefined()
        expect(histories).toEqual([branch])
      } else {
        expect(readError).toBeInstanceOf(EventRefsAcquireExhausted)
        const exhausted = readError as EventRefsAcquireExhausted
        expect(exhausted.attempts).toBe(8)
        expect(exhausted.refs).toEqual([ref])
      }
    }
  }, 30_000)

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
    // Default readers used by cleanup and submit must still distinguish malformed custody from absence.
    await expect(readBranchHistory(location, "lab", "task/broken")).rejects.toThrow(/needs an open change/u)
    const oldDrop = histories.get("task/old-drop")
    expect(oldDrop?.state).toMatchObject({
      status: "cancelled",
      diagnostic: expect.stringContaining("no opened event"),
    })
    const segments = enumerateChangeSegments(oldDrop?.events ?? [], changesRef("lab", "task/old-drop"), store.repo)
    expect(segments).toHaveLength(1)
    expect(
      eventListRows(new Map([["task/old-drop", segments.map((segment) => segment.state)]]), [], { all: true }).table,
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
      /migration writer is retired/,
    )
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

  /** @failure The read path pages a long queue, but its real writer still refuses event 1025.
   * @level l1 @consumer Yrd queue run's direct-commit observation
   */
  it("reads and writes a queue chain beyond one page", async () => {
    const { store, location } = remoteMemStore("yrd-long-concurrent-list")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    const queueTip = await seedEventQueue(location, "lab", commit, new Date("2026-09-22T14:00:00.000Z"))
    const branch = await openEvents({ ...store, ref: queueRef("lab") })
    let tip = await seedOpsCutover(location, "lab")
    for (let i = 0; i < 1024; i++) {
      const written = await branch.append(
        [
          {
            type: "started",
            props: [
              ["Queue", tip],
              ["Time", "2026-09-22T14:00:00.000Z"],
            ],
          },
        ],
        { expect: tip },
      )
      if (written.head === null) throw new Error("fixture start event was not written")
      tip = written.head
    }
    expect((await readEventQueueWithChanges(location, "lab")).queue.created).toBe(queueTip)
    const observed = await writeQueueEvent(location, "lab", {
      type: "observed",
      commit,
      by: QUEUE_RUN_WRITER,
      at: new Date("2026-09-22T14:01:00.000Z"),
    })
    expect((await readEventQueue(location, "lab")).observed[commit]?.id).toBe(observed)
    const admitted = await readEventOps(location, gitIn(store.repo), "lab", commit)
    expect(admitted.queue.created).toBe(queueTip)
    expect(admitted.queue.observed[commit]?.id).toBe(observed)
    expect(admitted.queue.tip).toBe(observed)
    expect(await branch.head()).toBe(observed)
  })

  /** @failure Missing remote queue authority must be named, never read as a running empty queue. */
  it("refuses an absent queue when reading remote ops", async () => {
    const { store, location } = remoteMemStore("yrd-absent-ops-queue")
    await expect(readEventOps(location, gitIn(store.repo), "lab", A)).rejects.toThrow(
      /yrd-absent-ops-queue: required queue ref refs\/yrd\/lab\/queue is missing/u,
    )
  })

  /** @failure A backend without acquisition support must not fall back to an independently listed authority. */
  it("refuses a remote ops backend that cannot fetch refs", async () => {
    const { store, location } = remoteMemStore("yrd-unsupported-ops-backend")
    await expect(
      readEventOps(
        { ...location, backend: { ...location.backend, fetchRefs: undefined } },
        gitIn(store.repo),
        "lab",
        A,
      ),
    ).rejects.toThrow(/backend cannot fetch queue refs\/yrd\/lab\/queue and retired legacy ref refs\/yrd\/lab\/pause/u)
  })

  it("pages a listed change chain beyond 1024 events without dropping its opening", async () => {
    const { store, location } = remoteMemStore("yrd-long-change-list")
    const branch = "task/long"
    const ref = changesRef("lab", branch)
    const chain = await openEvents({ ...store, ref })
    const written = await chain.append(
      Array.from({ length: 1025 }, () => input("marker")),
      { expect: null },
    )
    const first = written.events[0]?.id
    if (first === undefined) throw new Error("fixture did not write the opening event")
    const listed = await readEventChains(ref.slice(0, -branch.length), location)
    expect(listed.get(ref)).toHaveLength(1025)
    expect(listed.get(ref)?.[0]?.id).toBe(first)
  })

  it("reads a change chain beyond one page from a fixed acquired tip", async () => {
    const { store, location } = remoteMemStore("yrd-long-fixed-tip")
    const branch = "task/long-tip"
    const ref = changesRef("lab", branch)
    const chain = await openEvents({ ...store, ref })
    const written = await chain.append(
      Array.from({ length: 1025 }, () => input("marker")),
      { expect: null },
    )
    const first = written.events[0]?.id
    const tip = await chain.head()
    if (first === undefined || tip === null) throw new Error("fixture did not write the chain")
    const read = await readEventChain(chain, tip)
    expect(read).toHaveLength(1025)
    expect(read[0]?.id).toBe(first)
    expect(read.at(-1)?.id).toBe(tip)
  })

  it("omits event-chain pressure when no write cap remains, and succeeds on 1025-event chains (#26760)", async () => {
    const { store, location } = remoteMemStore("yrd-chain-over-1024")
    const target = await open({ ...store, ref: "refs/heads/lab" })
    const commit = (await target.transact(async (map) => map.set(".yrd.yml", "target: lab"), "declare")).oid
    let tip = await seedEventQueue(location, "lab", commit, new Date(Date.now() - 60_000))
    const chain = await openEvents({ ...store, ref: queueRef("lab") })
    const nowIso = new Date().toISOString()
    for (let i = 0; i < 1024; i++) {
      const written = await chain.append(
        [
          {
            type: "started",
            props: [
              ["Queue", tip],
              ["Time", nowIso],
            ],
          },
        ],
        { expect: tip },
      )
      if (written.head === null) throw new Error("fixture event was not written")
      tip = written.head
    }

    // 1025 total events in the queue
    const queue = await readEventQueue(location, "lab")
    expect(queue.tip).toBe(tip)
    // No Gitomic transact write cap exists, so writePressure must be omitted rather than reporting a false 1024 cap
    expect(queue.writePressure).toBeUndefined()

    // Subsequent write past 1024 events still succeeds
    const nextWrite = await chain.append(
      [
        {
          type: "started",
          props: [
            ["Queue", tip],
            ["Time", new Date().toISOString()],
          ],
        },
      ],
      { expect: tip },
    )
    expect(nextWrite.head).not.toBeNull()
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

describe("a cancellation names its actor and its coordination recipient (27262)", () => {
  const at = new Date("2026-10-03T12:00:00.000Z")

  it("writes Recipient: only on cancelled, beside the actor in By:", () => {
    const cancelled = changeInput("cancelled", {
      queueTip: A,
      at,
      commit: B,
      by: "@dev/actor",
      recipient: "@dev/recipient",
      reason: "withdrawn",
    })
    expect(cancelled.props).toContainEqual(["By", "@dev/actor"])
    expect(cancelled.props).toContainEqual(["Recipient", "@dev/recipient"])
  })

  it("refuses an empty Recipient: at write and at replay", () => {
    expect(() =>
      changeInput("cancelled", { queueTip: A, at, commit: B, by: "@dev/actor", recipient: "   ", reason: "withdrawn" }),
    ).toThrow(/Recipient: cannot be empty/)
    const opened = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    expect(() =>
      evolve(
        opened,
        event("cancelled", B, [
          ["Reason", "withdrawn"],
          ["Recipient", "  "],
        ]),
      ),
    ).toThrow(/empty Recipient/)
  })

  it("refuses Recipient: on any event but cancelled, at write and at replay", () => {
    expect(() =>
      changeInput("opened", { queueTip: A, at, commit: B, by: "@dev/actor", recipient: "@dev/recipient" }),
    ).toThrow(/Recipient: belongs on cancelled/)
    expect(() =>
      evolve(
        initial,
        event(
          "opened",
          A,
          [
            ["Commit", A],
            ["Recipient", "@dev/recipient"],
          ],
          [A],
        ),
      ),
    ).toThrow(/carries Recipient: on opened/)
  })

  it("refuses a repeated Recipient: at replay", () => {
    const opened = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    expect(() =>
      evolve(
        opened,
        event("cancelled", B, [
          ["Reason", "withdrawn"],
          ["Recipient", "@dev/one"],
          ["Recipient", "@dev/two"],
        ]),
      ),
    ).toThrow(/repeats Recipient:/)
  })

  it("accepts one seat as both actor and recipient, and accepts an absent Recipient:", () => {
    const opened = evolve(initial, event("opened", A, [["Commit", A]], [A]))
    const same = evolve(
      opened,
      event("cancelled", B, [
        ["Reason", "withdrawn"],
        ["By", "@dev/same"],
        ["Recipient", "@dev/same"],
      ]),
    )
    expect(same.status).toBe("cancelled")
    const absent = evolve(opened, event("cancelled", B, [["Reason", "resubmitted"]]))
    expect(absent.status).toBe("cancelled")
    expect(absent.reason).toBe("resubmitted")
  })
})
