/**
 * @failure Background settlement of terminal delivery facts advances its cursor before the settler acknowledged them, drops a failure that only ever reached a detached process's stderr, or resumes from a cursor written by a different owner.
 * @level l2
 * @consumer @yrd/cli composition hosts that close their own out-of-band records when Yrd commits a terminal PR fact
 */
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command, createMemoryJournal, event, type Journal } from "@yrd/core"
import { afterEach, describe, expect, it } from "vitest"

import {
  YRD_SETTLEMENT_HOOK_ENV,
  YRD_SETTLEMENT_STATE_ENV,
  drainSettlements,
  drainYrdSettlementNotices,
  isQueueRunInvocation,
  prepareYrdSettlementLaunch,
  readSettlementCursor,
  settlementCursorPath,
  settlementNoticeDir,
  settlementStateSegments,
  spawnYrdSettlementWorker,
  terminalSettlementTargets,
  writeSettlementCursor,
  type YrdSettlementHook,
  type YrdSettlementTarget,
} from "../src/settlement.ts"

const roots: string[] = []

function temporaryDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

let frames = 0

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** One journal frame carrying the events a test needs, valid to the real reader. */
function frame(events: readonly Readonly<{ name: string; data: unknown }>[]): unknown {
  const label = `frame:${(frames += 1)}`
  const command = { id: uuid(`command:${label}`), op: "test/settle" }
  return {
    cause: { id: uuid(`cause:${label}`), commandId: command.id, op: command.op, commandHash: Command.hash(command) },
    command,
    events: events.map((draft, index) => ({
      id: uuid(`event:${label}:${index}`),
      ts: "2026-08-17T12:00:00.000Z",
      ...event(draft.name, draft.data as never),
    })),
  }
}

function terminal(name: string, key: string, value: string): Readonly<{ name: string; data: unknown }> {
  return { name, data: { props: { [key]: value } } }
}

/** A pre-props journal frame: the payload spells `correlation: {namespace, id}`. */
function legacyTerminal(name: string, namespace: string, id: string): Readonly<{ name: string; data: unknown }> {
  return { name, data: { correlation: { namespace, id } } }
}

type RecordingHook = YrdSettlementHook & Readonly<{ settled: YrdSettlementTarget[][]; integrations: number }>

function recordingHook(overrides: Partial<YrdSettlementHook> = {}): RecordingHook {
  const settled: YrdSettlementTarget[][] = []
  const counts = { integrations: 0 }
  return {
    key: "host-request",
    owner: "@seat/1",
    settle: (targets) => {
      settled.push([...targets])
      return Promise.resolve()
    },
    integrated: () => {
      counts.integrations += 1
      return Promise.resolve()
    },
    ...overrides,
    get settled() {
      return settled
    },
    get integrations() {
      return counts.integrations
    },
  } as RecordingHook
}

function drainOptions(stateDir: string, hook: YrdSettlementHook, journal: Journal<unknown>) {
  return {
    repository: {
      stateDir,
      repo: stateDir,
      worktree: stateDir,
      gitDir: stateDir,
      baysRoot: stateDir,
      defaultBase: "main",
    },
    hook,
    stateDir,
    journal,
    retries: 0,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("terminalSettlementTargets", () => {
  it("collects every terminal fact carrying the asked-for prop key", () => {
    const values = [
      frame([terminal("pr/integrated", "host-request", "one")]),
      frame([terminal("pr/rejected", "host-request", "two"), terminal("pr/withdrawn", "other", "three")]),
      frame([terminal("pr/canceled", "host-request", "four")]),
    ]
    const found = terminalSettlementTargets(values, "host-request")
    expect(found.targets.map(({ value }) => value)).toEqual(["one", "two", "four"])
    expect(found.integrated).toBe(true)
  })

  it("settles pre-props journal frames spelled correlation: {namespace, id}", () => {
    const values = [frame([legacyTerminal("pr/rejected", "host-request", "legacy")])]
    const found = terminalSettlementTargets(values, "host-request")
    expect(found.targets).toEqual([{ key: "host-request", value: "legacy", eventId: expect.any(String) }])
  })

  it("ignores non-terminal events and terminals with no props", () => {
    const values = [
      frame([{ name: "pr/pushed", data: { props: { "host-request": "nope" } } }]),
      frame([{ name: "pr/rejected", data: { reason: "no props here" } }]),
    ]
    expect(terminalSettlementTargets(values, "host-request")).toEqual({ targets: [], integrated: false })
  })

  it("reports an integration even when no prop with this key rode with it", () => {
    const found = terminalSettlementTargets([frame([terminal("pr/integrated", "other", "x")])], "host-request")
    expect(found.targets).toEqual([])
    expect(found.integrated).toBe(true)
  })

  it("deduplicates a props repeated on the same event", () => {
    const repeated = frame([terminal("pr/rejected", "host-request", "one")])
    expect(terminalSettlementTargets([repeated, repeated], "host-request").targets).toHaveLength(1)
  })
})

describe("settlement cursors", () => {
  it("refuses a missing cursor for a registered worker instead of inventing 0", async () => {
    const dir = temporaryDir("yrd-settlement-cursor-")
    const path = join(dir, "missing.json")
    await expect(readSettlementCursor(path, "@seat/1")).rejects.toThrow(/missing\.json/)
    await expect(readSettlementCursor(path, "@seat/1")).rejects.toThrow(/@seat\/1/)
    await expect(readSettlementCursor(path, "@seat/1")).rejects.toThrow(/evictedThrough/)
  })

  it("round-trips a cursor for its owner", async () => {
    const dir = temporaryDir("yrd-settlement-cursor-roundtrip-")
    const path = settlementCursorPath(dir, "@seat/1")
    await writeSettlementCursor(path, "@seat/1", 42)
    await expect(readSettlementCursor(path, "@seat/1")).resolves.toBe(42)
  })

  it("refuses a cursor written by a different owner instead of resuming from it", async () => {
    const dir = temporaryDir("yrd-settlement-cursor-owner-")
    const path = settlementCursorPath(dir, "@seat/1")
    await writeSettlementCursor(path, "@seat/1", 7)
    await expect(readSettlementCursor(path, "@seat/2")).rejects.toThrow("settlement cursor is invalid")
  })

  it("names a recovery that does not convert a readable cursor into ENOENT", async () => {
    const dir = temporaryDir("yrd-settlement-cursor-repair-")
    const path = join(dir, "broken.json")
    writeFileSync(path, "{ not json")
    await expect(readSettlementCursor(path, undefined)).rejects.toThrow(/recovery:/)
    await expect(readSettlementCursor(path, undefined)).rejects.not.toThrow(/mv -n --/)
  })

  it("keeps owned and ownerless cursors in different files", () => {
    const dir = temporaryDir("yrd-settlement-cursor-split-")
    expect(settlementCursorPath(dir, undefined)).toBe(join(dir, "ownerless-v2.json"))
    expect(settlementCursorPath(dir, "@seat/1")).not.toBe(settlementCursorPath(dir, "@seat/2"))
  })
})

describe("drainSettlements", () => {
  it("hands every terminal fact to the hook and advances the cursor past them", async () => {
    const stateDir = temporaryDir("yrd-settlement-drain-")
    const hook = recordingHook()
    const journal = createMemoryJournal([
      frame([terminal("pr/rejected", "host-request", "one")]),
      frame([terminal("pr/integrated", "host-request", "two")]),
    ])
    await expect(drainSettlements(drainOptions(stateDir, hook, journal))).resolves.toBeUndefined()
    expect(hook.settled.flat().map(({ value }) => value)).toEqual(["one", "two"])
    expect(hook.integrations).toBe(1)
    await expect(readSettlementCursor(settlementCursorPath(stateDir, "@seat/1"), "@seat/1")).resolves.toBe(2)
  })

  it("leaves the cursor unmoved when the hook refuses, so the next drain retries the range", async () => {
    const stateDir = temporaryDir("yrd-settlement-drain-refused-")
    const hook = recordingHook({ settle: () => Promise.reject(new Error("host said no")) })
    const journal = createMemoryJournal([frame([terminal("pr/rejected", "host-request", "one")])])
    const failure = await drainSettlements(drainOptions(stateDir, hook, journal))
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("host said no")
    await expect(readSettlementCursor(settlementCursorPath(stateDir, "@seat/1"), "@seat/1")).resolves.toBe(0)
  })

  it("writes the failure down so a detached worker's error is not lost with its stderr", async () => {
    const stateDir = temporaryDir("yrd-settlement-drain-record-")
    const hook = recordingHook({ settle: () => Promise.reject(new Error("host said no")) })
    await drainSettlements(
      drainOptions(stateDir, hook, createMemoryJournal([frame([terminal("pr/rejected", "host-request", "one")])])),
    )
    const recorded = JSON.parse(
      readFileSync(join(stateDir, "errors-v1", `${Buffer.from("@seat/1", "utf8").toString("base64url")}.json`), "utf8"),
    ) as Record<string, unknown>
    expect(recorded).toMatchObject({ version: 1, owner: "@seat/1", error: "host said no" })
  })

  it("clears a recorded failure once the same owner drains cleanly", async () => {
    const stateDir = temporaryDir("yrd-settlement-drain-clear-")
    const errorPath = join(stateDir, "errors-v1", `${Buffer.from("@seat/1", "utf8").toString("base64url")}.json`)
    mkdirSync(join(stateDir, "errors-v1"), { recursive: true })
    writeFileSync(errorPath, `${JSON.stringify({ version: 1, owner: "@seat/1", error: "stale" })}\n`)
    await drainSettlements(drainOptions(stateDir, recordingHook(), createMemoryJournal([])))
    expect(() => readFileSync(errorPath, "utf8")).toThrow()
  })

  it("observes without settling when the hook declares no owner", async () => {
    const stateDir = temporaryDir("yrd-settlement-drain-ownerless-")
    const settled: YrdSettlementTarget[][] = []
    const hook: YrdSettlementHook = {
      key: "host-request",
      settle: (targets) => {
        settled.push([...targets])
        return Promise.resolve()
      },
    }
    const journal = createMemoryJournal([frame([terminal("pr/rejected", "host-request", "one")])])
    await drainSettlements(drainOptions(stateDir, hook, journal))
    expect(settled).toEqual([])
    await expect(readSettlementCursor(settlementCursorPath(stateDir, undefined), undefined)).resolves.toBe(1)
  })

  it("resumes from the cursor rather than re-settling history", async () => {
    const stateDir = temporaryDir("yrd-settlement-drain-resume-")
    const hook = recordingHook()
    const journal = createMemoryJournal([
      frame([terminal("pr/rejected", "host-request", "one")]),
      frame([terminal("pr/rejected", "host-request", "two")]),
    ])
    await writeSettlementCursor(settlementCursorPath(stateDir, "@seat/1"), "@seat/1", 1)
    await drainSettlements(drainOptions(stateDir, hook, journal))
    expect(hook.settled.flat().map(({ value }) => value)).toEqual(["two"])
  })

  it("leaves the hook open across passes, because a resident worker drains it many times", async () => {
    const stateDir = temporaryDir("yrd-settlement-drain-close-")
    let closed = 0
    const hook = recordingHook({
      close: () => {
        closed += 1
      },
    })
    await drainSettlements(drainOptions(stateDir, hook, createMemoryJournal([])))
    await drainSettlements(drainOptions(stateDir, hook, createMemoryJournal([])))
    expect(closed).toBe(0)
  })
})

describe("settlementStateSegments", () => {
  it("defaults to one plain directory when the host declares nothing", () => {
    expect(settlementStateSegments({})).toEqual(["settlements"])
  })

  it("lets a host keep an existing layout so a cutover does not rewind the cursor", () => {
    expect(settlementStateSegments({ [YRD_SETTLEMENT_STATE_ENV]: "tent/wire-settlements" })).toEqual([
      "tent",
      "wire-settlements",
    ])
  })

  it.each(["../escape", "/absolute", "tent//empty", "tent/.", "back\\slash"])("refuses %s", (declared) => {
    expect(() => settlementStateSegments({ [YRD_SETTLEMENT_STATE_ENV]: declared })).toThrow(
      "must be a relative path of plain segments",
    )
  })
})

describe("prepareYrdSettlementLaunch", () => {
  const base = {
    args: ["queue", "list"],
    execPath: "/usr/bin/bun",
    scriptPath: "/repo/bin/yrd",
    cwd: "/repo",
    stderr: undefined,
    write: () => undefined,
  }

  it("is inert for a standalone Yrd, without so much as looking for a Git directory", () => {
    let asked = 0
    const launch = prepareYrdSettlementLaunch({
      ...base,
      env: {},
      gitDir: () => {
        asked += 1
        return "/repo/.git"
      },
    })
    expect(launch).toBeUndefined()
    expect(asked).toBe(0)
  })

  it("arms once a host names a hook, and puts notices under the declared state path", () => {
    const paths: string[] = []
    const launch = prepareYrdSettlementLaunch({
      ...base,
      env: { [YRD_SETTLEMENT_HOOK_ENV]: "/repo/hook.ts", [YRD_SETTLEMENT_STATE_ENV]: "host/records" },
      gitDir: () => "/repo/.git",
      write: (text) => paths.push(text),
    })
    expect(launch?.resident).toBe(false)
    expect(settlementNoticeDir("/repo/.git", ["host", "records"])).toBe(join("/repo/.git/yrd/host/records/notices"))
    expect(paths).toEqual([])
  })

  it("rides beside a queue runner rather than after it", () => {
    const launch = prepareYrdSettlementLaunch({
      ...base,
      args: ["--repo", "/repo", "queue", "run"],
      env: { [YRD_SETTLEMENT_HOOK_ENV]: "/repo/hook.ts" },
      gitDir: () => "/repo/.git",
    })
    expect(launch?.resident).toBe(true)
  })

  it("warns instead of throwing when the worker cannot be started at all", () => {
    const warnings: string[] = []
    spawnYrdSettlementWorker({
      execPath: "/nonexistent/runtime",
      scriptPath: "/repo/bin/yrd",
      cwd: temporaryDir("yrd-settlement-spawn-"),
      env: {},
      settlementCwd: "/repo",
      noticePath: "/repo/notice.json",
      resident: false,
      stderr: undefined,
      warn: (text) => warnings.push(text),
    })
    // The spawn failure surfaces either synchronously or on the child's error
    // event; either way the caller's command is never taken down by it.
    expect(warnings.every((text) => text.startsWith("warning: Yrd could not start background completion work"))).toBe(
      true,
    )
  })
})

describe("isQueueRunInvocation", () => {
  it.each([
    { args: ["queue", "run"], expected: true },
    { args: ["--repo", "/x", "queue", "run", "PR1"], expected: true },
    { args: ["queue", "run", "--once"], expected: true },
    { args: ["queue", "list"], expected: false },
    { args: ["run"], expected: false },
    { args: ["pr", "run"], expected: false },
  ])("reads $args as $expected", ({ args, expected }) => {
    expect(isQueueRunInvocation(args)).toBe(expected)
  })
})

describe("drainYrdSettlementNotices", () => {
  it("says nothing when no worker ever failed", () => {
    const lines: string[] = []
    drainYrdSettlementNotices(join(temporaryDir("yrd-notices-empty-"), "notices"), (text) => lines.push(text))
    expect(lines).toEqual([])
  })

  it("delivers a prior worker's failure once and then removes it", () => {
    const dir = temporaryDir("yrd-notices-deliver-")
    const failedAt = new Date(Date.now() - 300_000).toISOString()
    writeFileSync(
      join(dir, "1.json"),
      `${JSON.stringify({ version: 1, owner: "@seat/1", commandCwd: "/repo", failedAt, error: "boom" })}\n`,
    )
    const first: string[] = []
    drainYrdSettlementNotices(dir, (text) => first.push(text))
    expect(first).toEqual([
      `warning: background work from a previous Yrd command for @seat/1 failed in /repo 5m ago (${failedAt}): boom\n`,
    ])
    const second: string[] = []
    drainYrdSettlementNotices(dir, (text) => second.push(text))
    expect(second).toEqual([])
  })

  it("quarantines a notice it cannot read rather than dropping the evidence that something failed", () => {
    const dir = temporaryDir("yrd-notices-invalid-")
    writeFileSync(join(dir, "broken.json"), "{ not json")
    const lines: string[] = []
    drainYrdSettlementNotices(dir, (text) => lines.push(text))
    expect(lines.join("")).toContain("invalid prior settlement warning")
    const quarantined = readdirSync(join(dir, "invalid"))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dir, "invalid", quarantined[0] ?? ""), "utf8")).toBe("{ not json")
  })

  it("dates the warning, so a three-day-old failure cannot read as current", () => {
    const dir = temporaryDir("yrd-notices-age-")
    const failedAt = new Date(Date.now() - 3 * 86_400_000).toISOString()
    writeFileSync(
      join(dir, "1.json"),
      `${JSON.stringify({ version: 1, owner: "@seat/1", commandCwd: "/repo", failedAt, error: "boom" })}\n`,
    )
    const lines: string[] = []
    drainYrdSettlementNotices(dir, (text) => lines.push(text))
    expect(lines).toEqual([
      `warning: background work from a previous Yrd command for @seat/1 failed in /repo 3d ago (${failedAt}): boom\n`,
    ])
  })

  it("quarantines an undated result rather than printing an ageless warning", () => {
    const dir = temporaryDir("yrd-notices-undated-")
    const body = `${JSON.stringify({ version: 1, owner: "@seat/1", commandCwd: "/repo", error: "boom" })}\n`
    writeFileSync(join(dir, "undated.json"), body)
    const lines: string[] = []
    drainYrdSettlementNotices(dir, (text) => lines.push(text))
    expect(lines.join("")).toContain("invalid prior settlement warning")
    expect(lines.join("")).not.toContain("background work from a previous Yrd command")
    const quarantined = readdirSync(join(dir, "invalid"))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dir, "invalid", quarantined[0] ?? ""), "utf8")).toBe(body)
  })

  it("quarantines a failedAt that does not parse, rather than rendering its age as NaN", () => {
    const dir = temporaryDir("yrd-notices-unparsable-")
    writeFileSync(
      join(dir, "skewed.json"),
      `${JSON.stringify({ version: 1, commandCwd: "/repo", failedAt: "last tuesday", error: "boom" })}\n`,
    )
    const lines: string[] = []
    drainYrdSettlementNotices(dir, (text) => lines.push(text))
    expect(lines.join("")).toContain("invalid prior settlement warning")
    expect(lines.join("")).not.toContain("NaN")
    expect(readdirSync(join(dir, "invalid"))).toHaveLength(1)
  })
})
