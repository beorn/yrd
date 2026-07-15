/**
 * @failure PR signals gate journal commits, duplicate after cursor recovery, or route away from the recorded submitter.
 * @level l3
 * @consumer @yrd/cli signal observer
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Command, createMemoryJournal } from "@yrd/core"
import { createJournal } from "@yrd/persistence"
import type { ProcessRequest } from "@yrd/process"
import {
  createSignalObserver,
  createTribeSignalAdapter,
  type RejectedSignal,
  type SignalDelivery,
  type SignalDeliveryAdapter,
  type SignalClosure,
} from "../src/signals.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-signals-"))
  roots.push(root)
  return root
}

function rejectedFrame(eventId = "00000000-0000-7000-8000-000000000003") {
  const command = { id: "00000000-0000-7000-8000-000000000001", op: "queue.finish" }
  return {
    command,
    cause: {
      id: "00000000-0000-7000-8000-000000000002",
      commandId: command.id,
      op: command.op,
      commandHash: Command.hash(command),
    },
    events: [
      {
        id: eventId,
        name: "pr/rejected",
        ts: "2026-07-14T10:00:00.000Z",
        data: {
          pr: "PR7",
          revision: 3,
          headSha: "a".repeat(40),
          run: "R9",
          actor: "@agent/7",
          step: "check",
          evidence: "/repo/.git/yrd/artifacts/R9/check/stderr.log",
          detail: "focused tests failed",
        },
      },
    ],
  }
}

function legacyRejectedFrame() {
  const frame = rejectedFrame("00000000-0000-7000-8000-000000000006")
  const event = frame.events[0]!
  const { actor: _actor, step: _step, evidence: _evidence, ...legacy } = event.data
  const command = { id: "00000000-0000-7000-8000-000000000004", op: "queue.finish" }
  return {
    ...frame,
    command,
    cause: {
      id: "00000000-0000-7000-8000-000000000005",
      commandId: command.id,
      op: command.op,
      commandHash: Command.hash(command),
    },
    events: [{ ...event, data: legacy }],
  }
}

function legacyRevisionRejectedFrame() {
  const frame = rejectedFrame("00000000-0000-7000-8000-000000000009")
  const event = frame.events[0]!
  const { actor: _actor, ...legacyRevision } = event.data
  const command = { id: "00000000-0000-7000-8000-000000000007", op: "queue.finish" }
  return {
    ...frame,
    command,
    cause: {
      id: "00000000-0000-7000-8000-000000000008",
      commandId: command.id,
      op: command.op,
      commandHash: Command.hash(command),
    },
    events: [{ ...event, data: legacyRevision }],
  }
}

function recordingAdapter(deliveries: SignalDelivery[], closures: SignalClosure[] = []): SignalDeliveryAdapter {
  return {
    send: (delivery) => void deliveries.push(delivery),
    close: (closure) => void closures.push(closure),
  }
}

describe("PR signal observer", () => {
  it("returns the journal append before a dead adapter settles, so delivery cannot gate the Run", async () => {
    const journal = createMemoryJournal<unknown>()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: { "pr/rejected": ["submitter"] },
      adapter: {
        async send() {
          entered.resolve()
          await release.promise
        },
      },
    })
    observer.start()

    await expect(observer.journal.append(rejectedFrame(), 0)).resolves.toEqual({ appended: true, cursor: 1 })
    await entered.promise

    release.resolve()
    await observer.close()
  })

  it("replays a durable append-before-send crash once and records the event id before the next restart", async () => {
    const dir = await stateDir()
    await createJournal({ dir }).append(rejectedFrame(), 0)
    const deliveries: SignalDelivery[] = []

    // The journal append belongs to the crashed process. Its observer never ran.
    const recovered = createSignalObserver({
      journal: createJournal({ dir }),
      stateDir: dir,
      routes: { "pr/rejected": ["submitter"] },
      adapter: recordingAdapter(deliveries),
    })
    recovered.start()
    await recovered.close()

    const restarted = createSignalObserver({
      journal: createJournal({ dir }),
      stateDir: dir,
      routes: { "pr/rejected": ["submitter"] },
      adapter: recordingAdapter(deliveries),
    })
    restarted.start()
    await restarted.close()

    expect(deliveries).toEqual([
      {
        recipient: "@agent/7",
        event: expect.objectContaining({
          id: "00000000-0000-7000-8000-000000000003",
          kind: "pr/rejected",
          pr: "PR7",
          revision: 3,
          run: "R9",
          step: "check",
          evidence: "/repo/.git/yrd/artifacts/R9/check/stderr.log",
        }),
      },
    ])
  })

  it("advances past pre-notification rejection history before routing current events", async () => {
    const journal = createMemoryJournal<unknown>([legacyRejectedFrame(), rejectedFrame()])
    const deliveries: SignalDelivery[] = []
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: { "pr/rejected": ["submitter"] },
      adapter: recordingAdapter(deliveries),
    })

    observer.start()
    await observer.close()

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.event.id).toBe("00000000-0000-7000-8000-000000000003")
  })

  it("advances past a current rejection whose legacy revision has no recorded submitter", async () => {
    const journal = createMemoryJournal<unknown>([legacyRevisionRejectedFrame(), rejectedFrame()])
    const deliveries: SignalDelivery[] = []
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: { "pr/rejected": ["submitter"] },
      adapter: recordingAdapter(deliveries),
    })

    observer.start()
    await observer.close()

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.event.id).toBe("00000000-0000-7000-8000-000000000003")
  })

  it("persists per-recipient progress before advancing the shared journal cursor", async () => {
    const journal = createMemoryJournal<unknown>([rejectedFrame()])
    const dir = await stateDir()
    const deliveries: SignalDelivery[] = []
    const adapter: SignalDeliveryAdapter = {
      send: vi
        .fn<(delivery: SignalDelivery) => Promise<void>>()
        .mockImplementationOnce(async (delivery) => void deliveries.push(delivery))
        .mockRejectedValueOnce(new Error("tribe unavailable")),
    }
    const routes = { "pr/rejected": ["submitter", "@ci"] } as const

    const first = createSignalObserver({ journal, stateDir: dir, routes, adapter })
    first.start()
    await first.close()

    const recovered = createSignalObserver({
      journal,
      stateDir: dir,
      routes,
      adapter: recordingAdapter(deliveries),
    })
    recovered.start()
    await recovered.close()

    expect(deliveries.map(({ recipient }) => recipient)).toEqual(["@agent/7", "@ci"])
  })

  it("routes a submitted revision to the configured reviewer only when review is required", async () => {
    const frame = rejectedFrame("00000000-0000-7000-8000-000000000013")
    const event = frame.events[0]!
    const journal = createMemoryJournal<unknown>([
      {
        ...frame,
        events: [
          {
            ...event,
            name: "pr/submitted",
            data: { pr: "PR7", revision: 3, headSha: "a".repeat(40), actor: "@agent/7" },
          },
        ],
      },
    ])
    const deliveries: SignalDelivery[] = []
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: { "pr/needs-review": ["@cto"] },
      reviewRequired: true,
      adapter: recordingAdapter(deliveries),
    })

    observer.start()
    await observer.close()

    expect(deliveries).toEqual([
      {
        recipient: "@cto",
        event: expect.objectContaining({ kind: "pr/needs-review", pr: "PR7", revision: 3 }),
      },
    ])
  })

  it("aggregates one integration broadcast and closes every routed PR request ball", async () => {
    const frame = rejectedFrame("00000000-0000-7000-8000-000000000016")
    const event = frame.events[0]!
    const landingSha = "b".repeat(40)
    const journal = createMemoryJournal<unknown>([
      {
        ...frame,
        events: [
          {
            ...event,
            id: "00000000-0000-7000-8000-000000000016",
            name: "pr/integrated",
            data: {
              pr: "PR7",
              revision: 3,
              headSha: "a".repeat(40),
              actor: "@agent/7",
              run: "R9",
              landingSha,
            },
          },
          {
            ...event,
            id: "00000000-0000-7000-8000-000000000017",
            name: "pr/integrated",
            data: {
              pr: "PR8",
              revision: 1,
              headSha: "c".repeat(40),
              actor: "@agent/8",
              run: "R9",
              landingSha,
            },
          },
        ],
      },
    ])
    const deliveries: SignalDelivery[] = []
    const closures: SignalClosure[] = []
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: {
        "pr/rejected": ["submitter"],
        "pr/needs-review": ["@cto"],
        "pr/integrated": ["broadcast"],
      },
      adapter: recordingAdapter(deliveries, closures),
    })

    observer.start()
    await observer.close()

    expect(deliveries).toEqual([
      {
        recipient: "*",
        event: expect.objectContaining({
          kind: "pr/integrated",
          landingSha,
          prs: [expect.objectContaining({ pr: "PR7" }), expect.objectContaining({ pr: "PR8" })],
        }),
      },
    ])
    expect(closures.map(({ recipient, request }) => `${recipient} ${request}`)).toEqual([
      "@agent/7 yrd:pr/rejected:PR7:3:@agent/7",
      "@cto yrd:pr/needs-review:PR7:3:@cto",
      "@agent/8 yrd:pr/rejected:PR8:1:@agent/8",
      "@cto yrd:pr/needs-review:PR8:1:@cto",
    ])
  })

  it("routes a typed failed Run to each submitter and the configured CI recipient", async () => {
    const frame = rejectedFrame("00000000-0000-7000-8000-000000000020")
    const event = frame.events[0]!
    const journal = createMemoryJournal<unknown>([
      {
        ...frame,
        events: [
          {
            ...event,
            name: "queue/run/failed",
            data: {
              run: "R9",
              error: { code: "job-lost", message: "runner disappeared" },
              prs: [
                { pr: "PR7", revision: 3, headSha: "a".repeat(40), actor: "@agent/7" },
                { pr: "PR8", revision: 1, headSha: "c".repeat(40), actor: "@agent/8" },
              ],
            },
          },
        ],
      },
    ])
    const deliveries: SignalDelivery[] = []
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: { "run/failed": ["submitter", "@ci"] },
      adapter: recordingAdapter(deliveries),
    })

    observer.start()
    await observer.close()

    expect(deliveries.map(({ recipient }) => recipient)).toEqual(["@agent/7", "@agent/8", "@ci"])
    expect(deliveries[0]?.event).toMatchObject({ kind: "run/failed", run: "R9" })
  })

  it("refuses startup when configured Tribe routes have no live adapter", () => {
    const which = vi.spyOn(Bun, "which").mockReturnValue(null)
    try {
      let failure: unknown
      try {
        createTribeSignalAdapter({ run: vi.fn() })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({
        failure: { kind: "configuration", code: "signal-adapter-missing" },
      })
      expect((failure as Error).message).toContain("no live Tribe adapter")
    } finally {
      which.mockRestore()
    }
  })

  it("delivers a rejected PR as a tracked Tribe request carrying its evidence", async () => {
    const which = vi.spyOn(Bun, "which").mockReturnValue("/usr/local/bin/tribe")
    const requests: ProcessRequest[] = []
    try {
      const adapter = createTribeSignalAdapter({
        async run(request) {
          requests.push(request)
          return {
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
          }
        },
      })
      const raw = rejectedFrame().events[0]!
      await adapter.send({
        recipient: "@agent/7",
        event: {
          id: raw.id,
          kind: "pr/rejected",
          at: raw.ts,
          ...(raw.data as Omit<RejectedSignal, "id" | "kind" | "at">),
        },
      })

      expect(requests).toEqual([
        expect.objectContaining({
          argv: [
            "/usr/local/bin/tribe",
            "send",
            "@agent/7",
            expect.stringContaining("evidence=/repo/.git/yrd/artifacts/R9/check/stderr.log"),
            "--type",
            "request",
            "--summary",
            "PR7 rejected at check",
            "--request",
            "yrd:pr/rejected:PR7:3:@agent/7",
          ],
          timeoutMs: 5_000,
        }),
      ])
    } finally {
      which.mockRestore()
    }
  })

  it("uses ambient notify for integration and closes terminal request ids without a wakeup message", async () => {
    const which = vi.spyOn(Bun, "which").mockReturnValue("/usr/local/bin/tribe")
    const requests: ProcessRequest[] = []
    try {
      const adapter = createTribeSignalAdapter({
        async run(request) {
          requests.push(request)
          return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false }
        },
      })
      await adapter.send({
        recipient: "*",
        event: {
          id: "00000000-0000-7000-8000-000000000030",
          kind: "pr/integrated",
          at: "2026-07-14T10:00:00.000Z",
          run: "R9",
          landingSha: "b".repeat(40),
          prs: [{ pr: "PR7", revision: 3, headSha: "a".repeat(40), actor: "@agent/7" }],
        },
      })
      await adapter.close?.({
        recipient: "@agent/7",
        request: "yrd:pr/rejected:PR7:3:@agent/7",
        pr: "PR7",
        revision: 3,
        kind: "pr/rejected",
      })

      expect(requests.map(({ argv }) => argv)).toEqual([
        [
          "/usr/local/bin/tribe",
          "send",
          "*",
          expect.stringContaining(`at ${"b".repeat(40)}`),
          "--type",
          "notify",
          "--summary",
          "PR7 integrated",
        ],
        [
          "/usr/local/bin/tribe",
          "pending",
          "--owner",
          "@agent/7",
          "--close",
          "yrd:pr/rejected:PR7:3:@agent/7",
        ],
      ])
    } finally {
      which.mockRestore()
    }
  })
})
