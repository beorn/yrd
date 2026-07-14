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
import type { ProcessRequest } from "@yrd/process"
import {
  createSignalObserver,
  createTribeSignalAdapter,
  type SignalDelivery,
  type SignalDeliveryAdapter,
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
  return {
    ...frame,
    command: { id: "00000000-0000-7000-8000-000000000004", op: "queue.finish" },
    cause: {
      id: "00000000-0000-7000-8000-000000000005",
      commandId: "00000000-0000-7000-8000-000000000004",
      op: "queue.finish",
      commandHash: Command.hash({ id: "00000000-0000-7000-8000-000000000004", op: "queue.finish" }),
    },
    events: [{ ...event, data: legacy }],
  }
}

function recordingAdapter(deliveries: SignalDelivery[]): SignalDeliveryAdapter {
  return { send: (delivery) => void deliveries.push(delivery) }
}

describe("PR signal observer", () => {
  it("returns the journal append before a dead adapter settles, so a signal cannot gate the Run", async () => {
    const journal = createMemoryJournal<unknown>()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const adapter: SignalDeliveryAdapter = {
      async send() {
        entered.resolve()
        await release.promise
      },
    }
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: { "pr/rejected": ["submitter"] },
      adapter,
    })
    observer.start()

    await expect(observer.journal.append(rejectedFrame(), 0)).resolves.toEqual({ appended: true, cursor: 1 })
    await entered.promise
    expect(observer.pending()).toBe(true)

    release.resolve()
    await observer.flush()
    expect(observer.pending()).toBe(false)
    await observer.close()
  })

  it("replays a crash after append but before send exactly once across restarts", async () => {
    const journal = createMemoryJournal<unknown>()
    await journal.append(rejectedFrame(), 0)
    const dir = await stateDir()
    const deliveries: SignalDelivery[] = []

    const first = createSignalObserver({
      journal,
      stateDir: dir,
      routes: { "pr/rejected": ["submitter"] },
      adapter: recordingAdapter(deliveries),
    })
    first.start()
    await first.flush()
    await first.close()

    const restarted = createSignalObserver({
      journal,
      stateDir: dir,
      routes: { "pr/rejected": ["submitter"] },
      adapter: recordingAdapter(deliveries),
    })
    restarted.start()
    await restarted.flush()
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
    await observer.flush()
    await observer.close()

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.event.id).toBe("00000000-0000-7000-8000-000000000003")
  })

  it("records recipient progress per event before advancing a shared journal cursor", async () => {
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
    await first.flush()
    await first.close()

    const recovered = createSignalObserver({
      journal,
      stateDir: dir,
      routes,
      adapter: recordingAdapter(deliveries),
    })
    recovered.start()
    await recovered.flush()
    await recovered.close()

    expect(deliveries.map(({ recipient }) => recipient)).toEqual(["@agent/7", "@ci"])
  })

  it("refuses startup when configured Tribe routes have no live adapter", () => {
    const which = vi.spyOn(Bun, "which").mockReturnValue(null)
    try {
      expect(() => createTribeSignalAdapter({ run: vi.fn() })).toThrow("no live Tribe adapter")
    } finally {
      which.mockRestore()
    }
  })

  it("delivers a rejected PR as a tracked Tribe request with its evidence", async () => {
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
          ...(raw.data as Omit<SignalDelivery["event"], "id" | "kind" | "at">),
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
          ],
          timeoutMs: 5_000,
        }),
      ])
    } finally {
      which.mockRestore()
    }
  })
})
