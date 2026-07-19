/**
 * @failure PR signals gate journal commits, duplicate after cursor recovery, or route away from the recorded submitter.
 * @level l3
 * @consumer @yrd/cli signal observer
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Command, createMemoryJournal } from "@yrd/core"
import { createJournal } from "@yrd/persistence"
import type { Process, ProcessRequest } from "@yrd/process"
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

function submittedFrame(eventId: string, actor: string, revision: number) {
  const frame = rejectedFrame(eventId)
  const event = frame.events[0]!
  return {
    ...frame,
    events: [
      {
        ...event,
        name: "pr/submitted",
        data: { pr: "PR7", revision, headSha: "a".repeat(40), actor },
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

function recordingProcess(requests: ProcessRequest[]): Pick<Process, "run"> {
  return {
    async run(request) {
      requests.push(request)
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false }
    },
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

  it("migrates a top-level opened ledger without replaying delivered signals", async () => {
    const dir = await stateDir()
    const cursorPath = join(dir, "notifications", "cursor-v1.json")
    const opened = {
      pr: "PR7",
      revision: 3,
      kind: "pr/rejected",
      recipient: "@agent/old",
      requestId: "yrd:pr/rejected:PR7:3:@agent/old",
    }
    await mkdir(join(dir, "notifications"), { recursive: true })
    await writeFile(
      cursorPath,
      `${JSON.stringify({ version: 1, cursor: 1, sent: { "in-flight": ["@ci"] }, opened: [opened] })}\n`,
    )
    const journal = createMemoryJournal<unknown>([rejectedFrame()])
    const deliveries: SignalDelivery[] = []
    const closures: SignalClosure[] = []

    const migrated = createSignalObserver({
      journal,
      stateDir: dir,
      routes: { "pr/rejected": ["submitter"] },
      adapter: recordingAdapter(deliveries, closures),
    })
    migrated.start()
    await migrated.close()

    expect(deliveries).toEqual([])
    expect(JSON.parse(await readFile(cursorPath, "utf8"))).toEqual({
      version: 1,
      cursor: 1,
      sent: { "in-flight": ["@ci"], "yrd:opened:v1": [JSON.stringify(opened)] },
    })

    const rejected = rejectedFrame("00000000-0000-7000-8000-000000000030")
    const event = rejected.events[0]!
    await journal.append(
      {
        ...rejected,
        events: [
          {
            ...event,
            name: "pr/integrated",
            data: {
              pr: "PR7",
              revision: 3,
              headSha: "a".repeat(40),
              actor: "@agent/new",
              run: "R10",
              landingSha: "b".repeat(40),
            },
          },
        ],
      },
      1,
    )
    const restarted = createSignalObserver({
      journal,
      stateDir: dir,
      routes: { "pr/rejected": ["submitter"] },
      adapter: recordingAdapter(deliveries, closures),
    })
    restarted.start()
    await restarted.close()

    expect(deliveries).toEqual([])
    expect(closures).toContainEqual({
      recipient: "@agent/old",
      request: "yrd:pr/rejected:PR7:3:@agent/old",
      pr: "PR7",
      revision: 3,
      kind: "pr/rejected",
    })
    expect(closures).not.toContainEqual(expect.objectContaining({ recipient: "@agent/new", pr: "PR7", revision: 3 }))
    expect(JSON.parse(await readFile(cursorPath, "utf8"))).toEqual({
      version: 1,
      cursor: 2,
      sent: { "in-flight": ["@ci"] },
    })
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
    const journal = createMemoryJournal<unknown>([
      submittedFrame("00000000-0000-7000-8000-000000000013", "@agent/7", 3),
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
      "@agent/7 yrd:pr/rejected:PR7:1:@agent/7",
      "@agent/7 yrd:pr/rejected:PR7:2:@agent/7",
      "@agent/7 yrd:pr/rejected:PR7:3:@agent/7",
      "@cto yrd:pr/needs-review:PR7:1:@cto",
      "@cto yrd:pr/needs-review:PR7:2:@cto",
      "@cto yrd:pr/needs-review:PR7:3:@cto",
      "@agent/8 yrd:pr/rejected:PR8:1:@agent/8",
      "@cto yrd:pr/needs-review:PR8:1:@cto",
    ])
  })

  it("closes rejection and review balls for every prior revision when a later revision integrates", async () => {
    const frame = rejectedFrame("00000000-0000-7000-8000-000000000040")
    const event = frame.events[0]!
    const landingSha = "d".repeat(40)
    const journal = createMemoryJournal<unknown>([
      {
        ...frame,
        events: [
          {
            ...event,
            id: "00000000-0000-7000-8000-000000000040",
            name: "pr/integrated",
            data: { pr: "PR7", revision: 2, headSha: "a".repeat(40), actor: "@agent/7", run: "R9", landingSha },
          },
        ],
      },
    ])
    const closures: SignalClosure[] = []
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: { "pr/rejected": ["submitter"], "pr/needs-review": ["@cto"], "pr/integrated": ["broadcast"] },
      adapter: recordingAdapter([], closures),
    })

    observer.start()
    await observer.close()

    expect(closures.map(({ recipient, request }) => `${recipient} ${request}`)).toEqual([
      "@agent/7 yrd:pr/rejected:PR7:1:@agent/7",
      "@agent/7 yrd:pr/rejected:PR7:2:@agent/7",
      "@cto yrd:pr/needs-review:PR7:1:@cto",
      "@cto yrd:pr/needs-review:PR7:2:@cto",
    ])
  })

  it("closes rejection and review balls across revisions when a PR is withdrawn", async () => {
    const frame = rejectedFrame("00000000-0000-7000-8000-000000000041")
    const event = frame.events[0]!
    const journal = createMemoryJournal<unknown>([
      {
        ...frame,
        events: [
          {
            ...event,
            id: "00000000-0000-7000-8000-000000000041",
            name: "pr/withdrawn",
            data: { pr: "PR7", revision: 2, headSha: "a".repeat(40), actor: "@agent/7", reason: "superseded" },
          },
        ],
      },
    ])
    const closures: SignalClosure[] = []
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: { "pr/rejected": ["submitter"], "pr/needs-review": ["@cto"] },
      adapter: recordingAdapter([], closures),
    })

    observer.start()
    await observer.close()

    expect(closures.map(({ recipient, request }) => `${recipient} ${request}`)).toEqual([
      "@agent/7 yrd:pr/rejected:PR7:1:@agent/7",
      "@agent/7 yrd:pr/rejected:PR7:2:@agent/7",
      "@cto yrd:pr/needs-review:PR7:1:@cto",
      "@cto yrd:pr/needs-review:PR7:2:@cto",
    ])
  })

  it("closes rejection and review balls across revisions when a PR is canceled", async () => {
    const frame = rejectedFrame("00000000-0000-7000-8000-000000000042")
    const event = frame.events[0]!
    const journal = createMemoryJournal<unknown>([
      {
        ...frame,
        events: [
          {
            ...event,
            id: "00000000-0000-7000-8000-000000000042",
            name: "pr/canceled",
            data: {
              pr: "PR7",
              revision: 2,
              headSha: "a".repeat(40),
              run: "R9",
              actor: "@agent/7",
              by: "@chief",
              reason: "superseded by requeue",
            },
          },
        ],
      },
    ])
    const closures: SignalClosure[] = []
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: { "pr/rejected": ["submitter"], "pr/needs-review": ["@cto"] },
      adapter: recordingAdapter([], closures),
    })

    observer.start()
    await observer.close()

    expect(closures.map(({ recipient, request }) => `${recipient} ${request}`)).toEqual([
      "@agent/7 yrd:pr/rejected:PR7:1:@agent/7",
      "@agent/7 yrd:pr/rejected:PR7:2:@agent/7",
      "@cto yrd:pr/needs-review:PR7:1:@cto",
      "@cto yrd:pr/needs-review:PR7:2:@cto",
    ])
  })

  it("routes actor-carrying terminal closures to the submitter and skips submitter balls with no recorded actor", async () => {
    const frame = rejectedFrame("00000000-0000-7000-8000-000000000043")
    const event = frame.events[0]!
    const journal = createMemoryJournal<unknown>([
      {
        ...frame,
        events: [
          {
            ...event,
            id: "00000000-0000-7000-8000-000000000043",
            name: "pr/withdrawn",
            data: { pr: "PR7", revision: 1, headSha: "a".repeat(40), actor: "@agent/7" },
          },
          {
            ...event,
            id: "00000000-0000-7000-8000-000000000044",
            name: "pr/canceled",
            data: { pr: "PR8", revision: 1, headSha: "c".repeat(40), run: "R9", by: "@chief", reason: "no submitter" },
          },
        ],
      },
    ])
    const closures: SignalClosure[] = []
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: { "pr/rejected": ["submitter"] },
      adapter: recordingAdapter([], closures),
    })

    observer.start()
    await observer.close()

    expect(closures.map(({ recipient, request }) => `${recipient} ${request}`)).toEqual([
      "@agent/7 yrd:pr/rejected:PR7:1:@agent/7",
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

  it("delivers rejected PR evidence as a pull notification without opening a ball", async () => {
    const which = vi.spyOn(Bun, "which").mockReturnValue("/usr/local/bin/tribe")
    const requests: ProcessRequest[] = []
    try {
      const adapter = createTribeSignalAdapter(recordingProcess(requests))
      const raw = rejectedFrame().events[0]!
      await adapter.send({
        // A configured route can outlive the seat. Evidence remains journaled for pull
        // inspection, but must not create a semantic obligation owned by a dead handle.
        recipient: "@superci",
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
            "@superci",
            expect.stringContaining("evidence=/repo/.git/yrd/artifacts/R9/check/stderr.log"),
            "--type",
            "notify",
            "--summary",
            "PR7 rejected at check",
            "--delivery",
            "pull",
          ],
          timeoutMs: 5_000,
        }),
      ])
    } finally {
      which.mockRestore()
    }
  })

  it("delivers failed Run evidence as a pull notification without opening a ball", async () => {
    const which = vi.spyOn(Bun, "which").mockReturnValue("/usr/local/bin/tribe")
    const requests: ProcessRequest[] = []
    try {
      const adapter = createTribeSignalAdapter(recordingProcess(requests))
      await adapter.send({
        recipient: "@ci",
        event: {
          id: "00000000-0000-7000-8000-000000000021",
          kind: "run/failed",
          at: "2026-07-14T10:00:00.000Z",
          run: "R9",
          error: { code: "job-lost", message: "runner disappeared" },
          prs: [{ pr: "PR7", revision: 3, headSha: "a".repeat(40), actor: "@agent/7" }],
        },
      })

      expect(requests.map(({ argv }) => argv)).toEqual([
        [
          "/usr/local/bin/tribe",
          "send",
          "@ci",
          expect.stringMatching(/err=job-lost.*cause: runner disappeared.*resolve:/su),
          "--type",
          "notify",
          "--summary",
          "R9 failed",
          "--delivery",
          "pull",
        ],
      ])
    } finally {
      which.mockRestore()
    }
  })

  it("keeps needs-review actionable with an explicit ten-minute ball deadline", async () => {
    const which = vi.spyOn(Bun, "which").mockReturnValue("/usr/local/bin/tribe")
    const requests: ProcessRequest[] = []
    try {
      const adapter = createTribeSignalAdapter(recordingProcess(requests))
      await adapter.send({
        recipient: "@cto",
        event: {
          id: "00000000-0000-7000-8000-000000000022",
          kind: "pr/needs-review",
          at: "2026-07-14T10:00:00.000Z",
          pr: "PR7",
          revision: 3,
          headSha: "a".repeat(40),
          actor: "@agent/7",
        },
      })

      expect(requests.map(({ argv }) => argv)).toEqual([
        [
          "/usr/local/bin/tribe",
          "send",
          "@cto",
          expect.stringContaining("needs review for PR7 revision 3"),
          "--type",
          "request",
          "--summary",
          "PR7 needs review",
          "--delivery",
          "push",
          "--request",
          "yrd:pr/needs-review:PR7:3:@cto",
          "--expires-in-ms",
          "600000",
        ],
      ])
    } finally {
      which.mockRestore()
    }
  })

  it("uses ambient notify for integration and closes terminal request ids without a wakeup message", async () => {
    const which = vi.spyOn(Bun, "which").mockReturnValue("/usr/local/bin/tribe")
    const requests: ProcessRequest[] = []
    try {
      const adapter = createTribeSignalAdapter(recordingProcess(requests))
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
          "--delivery",
          "pull",
        ],
        ["/usr/local/bin/tribe", "pending", "--owner", "@agent/7", "--close", "yrd:pr/rejected:PR7:3:@agent/7"],
      ])
    } finally {
      which.mockRestore()
    }
  })

  it("does not record an evidence-only rejection as an opened request ball", async () => {
    const dir = await stateDir()
    const rejected = rejectedFrame("00000000-0000-7000-8000-000000000045")
    const terminal = rejectedFrame("00000000-0000-7000-8000-000000000046")
    const terminalEvent = terminal.events[0]!
    const integrated = {
      ...terminal,
      events: [
        {
          ...terminalEvent,
          name: "pr/integrated",
          data: {
            pr: "PR7",
            revision: 3,
            headSha: "a".repeat(40),
            actor: "@agent/7",
            run: "R9",
            landingSha: "b".repeat(40),
          },
        },
      ],
    }

    const opener = createSignalObserver({
      journal: createMemoryJournal<unknown>([rejected]),
      stateDir: dir,
      routes: { "pr/rejected": ["@ci"] },
      adapter: recordingAdapter([], []),
    })
    opener.start()
    await opener.close()

    const closures: SignalClosure[] = []
    const settler = createSignalObserver({
      journal: createMemoryJournal<unknown>([rejected, integrated]),
      stateDir: dir,
      routes: { "pr/integrated": ["broadcast"] },
      adapter: recordingAdapter([], closures),
    })
    settler.start()
    await settler.close()

    expect(closures).toEqual([])
  })

  it("settles a rejection ball retained in a pre-policy opened ledger", async () => {
    const dir = await stateDir()
    const notifications = join(dir, "notifications")
    await mkdir(notifications, { recursive: true })
    await writeFile(
      join(notifications, "cursor-v1.json"),
      `${JSON.stringify({
        version: 1,
        cursor: 0,
        sent: {},
        opened: [
          {
            pr: "PR7",
            revision: 1,
            kind: "pr/rejected",
            recipient: "@superci",
            requestId: "yrd:pr/rejected:PR7:1:@superci",
          },
        ],
      })}\n`,
    )
    const frame = rejectedFrame("00000000-0000-7000-8000-000000000047")
    const event = frame.events[0]!
    const journal = createMemoryJournal<unknown>([
      {
        ...frame,
        events: [
          {
            ...event,
            name: "pr/integrated",
            data: {
              pr: "PR7",
              revision: 2,
              headSha: "a".repeat(40),
              actor: "@agent/7",
              run: "R9",
              landingSha: "b".repeat(40),
            },
          },
        ],
      },
    ])
    const closures: SignalClosure[] = []
    const observer = createSignalObserver({
      journal,
      stateDir: dir,
      routes: { "pr/integrated": ["broadcast"] },
      adapter: recordingAdapter([], closures),
    })

    observer.start()
    await observer.close()

    expect(closures).toEqual([
      {
        recipient: "@superci",
        request: "yrd:pr/rejected:PR7:1:@superci",
        pr: "PR7",
        revision: 1,
        kind: "pr/rejected",
      },
    ])
  })

  it("closes the exact opened ball across an actor change on resubmission (opened-ledger authoritative)", async () => {
    // rev-1 needs review under submitter @agent/old; yrd legally reassigns the actor on the rev-2
    // resubmission, so the integration reports @agent/new. Re-deriving the rev-1 close id from the
    // terminal actor closes a ball that was never opened; the ledger closes the id actually sent.
    const opened = submittedFrame("00000000-0000-7000-8000-000000000050", "@agent/old", 1)
    const integrated = rejectedFrame("00000000-0000-7000-8000-000000000051")
    const integratedEvent = integrated.events[0]!
    const journal = createMemoryJournal<unknown>([
      opened,
      {
        ...integrated,
        events: [
          {
            ...integratedEvent,
            name: "pr/integrated",
            data: {
              pr: "PR7",
              revision: 2,
              headSha: "b".repeat(40),
              actor: "@agent/new",
              run: "R2",
              landingSha: "c".repeat(40),
            },
          },
        ],
      },
    ])
    const closures: SignalClosure[] = []
    const observer = createSignalObserver({
      journal,
      stateDir: await stateDir(),
      routes: { "pr/needs-review": ["submitter"], "pr/integrated": ["broadcast"] },
      reviewRequired: true,
      adapter: recordingAdapter([], closures),
    })

    observer.start()
    await observer.close()

    const ids = closures.map(({ recipient, request }) => `${recipient} ${request}`)
    // The ledger closes the ball actually opened for the rev-1 submitter…
    expect(ids).toContain("@agent/old yrd:pr/needs-review:PR7:1:@agent/old")
    // …and never re-derives rev-1 from the drifted terminal actor (r1's phantom, which left the real ball open).
    expect(ids).not.toContain("@agent/new yrd:pr/needs-review:PR7:1:@agent/new")
  })

  it("closes a ball opened under a since-removed route (route-drift, opened-ledger authoritative)", async () => {
    // rev-1 review fans out to the submitter AND @ci. By the time the PR integrates the project
    // has dropped @ci from its notify routes. Re-deriving from current routes never closes @ci's
    // ball; the ledger recorded it at open and closes it regardless of the later config.
    const dir = await stateDir()
    const openFrame = submittedFrame("00000000-0000-7000-8000-000000000052", "@agent/7", 1)
    const integrated = rejectedFrame("00000000-0000-7000-8000-000000000053")
    const integratedEvent = integrated.events[0]!
    const integrateFrame = {
      ...integrated,
      events: [
        {
          ...integratedEvent,
          name: "pr/integrated",
          data: {
            pr: "PR7",
            revision: 2,
            headSha: "b".repeat(40),
            actor: "@agent/7",
            run: "R2",
            landingSha: "c".repeat(40),
          },
        },
      ],
    }

    // Open under routes that still fan out to @ci.
    const opener = createSignalObserver({
      journal: createMemoryJournal<unknown>([openFrame]),
      stateDir: dir,
      routes: { "pr/needs-review": ["submitter", "@ci"] },
      reviewRequired: true,
      adapter: recordingAdapter([], []),
    })
    opener.start()
    await opener.close()

    // Terminal under routes that have since dropped @ci; the same durable state carries the ledger.
    const closures: SignalClosure[] = []
    const settler = createSignalObserver({
      journal: createMemoryJournal<unknown>([openFrame, integrateFrame]),
      stateDir: dir,
      routes: { "pr/needs-review": ["submitter"] },
      reviewRequired: true,
      adapter: recordingAdapter([], closures),
    })
    settler.start()
    await settler.close()

    const ids = closures.map(({ recipient, request }) => `${recipient} ${request}`)
    expect(ids).toContain("@ci yrd:pr/needs-review:PR7:1:@ci")
    expect(ids).toContain("@agent/7 yrd:pr/needs-review:PR7:1:@agent/7")
  })
})
