/**
 * @failure A queue outcome ends in NO ball, or in two: a refused change sits
 *          with nobody told, a yrd fault reaches the author instead of the
 *          owner, a re-run of the same attempt pages the same seat twice, or a
 *          notifier that died reads as delivered.
 * @level   l2
 * @consumer @yrd/cli `queue run --once` exit code · `.yrd.yml` owner:/notify: ·
 *           the hh-dev notifier (`tools/yrd-notify.ts`)
 *
 * Operator rulings 2026-09-01 (@i/10-yrd/24028): "every failure should result
 * in a ball"; "0 => next / 1 => check failed / 2 => yrd failed" — the third
 * code lands on `fatal-error` (17) here, because 2 is the generic
 * usage/configuration exit of every verb; see QUEUE_OUTCOME_EXIT.
 */
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { QueueOutcome } from "@yrd/queue"
import { loadYrdConfig, parseYrdConfig } from "../src/config.ts"
import { HABITANT_EXIT } from "../src/habitant-exit.ts"
import {
  createOutcomeLedger,
  createOutcomeNotifier,
  DEFAULT_QUEUE_OWNER,
  lookupNotifySeat,
  NOTIFY_TIMEOUT_MS,
  OUTCOME_LEDGER_FILE,
  outcomeExitCode,
  parseBallId,
  QUEUE_OUTCOME_EXIT,
  recordNotifySeat,
  routeOutcome,
  submitterSeatFromEnvironment,
  type NotifierRun,
  type OutcomeNotification,
} from "../src/outcome-notify.ts"

const SHA = "a".repeat(40)
const BASE_SHA = "b".repeat(40)

function outcome(overrides: Partial<QueueOutcome> = {}): QueueOutcome {
  return {
    kind: "refused",
    attemptId: `PR7@2:admission@${BASE_SHA}`,
    pr: "PR7",
    revision: 2,
    branch: "task/thing",
    sha: SHA,
    base: "main",
    baseSha: BASE_SHA,
    submitter: "@dev/3",
    code: "check-failed",
    reason: "typecheck failed",
    failureKind: "failure",
    attributableFailures: ["src/a.ts:12 TS2322 mismatch"],
    ...overrides,
  }
}

type LogRow = Readonly<{ level: "info" | "warn" | "error"; message: string; props?: Record<string, unknown> }>

function collectingLog(): Readonly<{ rows: LogRow[]; log: Parameters<typeof createOutcomeNotifier>[0]["log"] }> {
  const rows: LogRow[] = []
  return {
    rows,
    log: {
      info: (message, props) => rows.push({ level: "info", message, ...(props === undefined ? {} : { props }) }),
      warn: (message, props) => rows.push({ level: "warn", message, ...(props === undefined ? {} : { props }) }),
      error: (message, props) => rows.push({ level: "error", message, ...(props === undefined ? {} : { props }) }),
    },
  }
}

function fakeRun(
  reply: Readonly<{ code?: number | null; stdout?: string; stderr?: string; timedOut?: boolean }> = {},
): Readonly<{ calls: OutcomeNotification[]; commands: string[]; run: NotifierRun }> {
  const calls: OutcomeNotification[] = []
  const commands: string[] = []
  return {
    calls,
    commands,
    run: async (command, input) => {
      commands.push(command)
      calls.push(JSON.parse(input) as OutcomeNotification)
      return {
        code: reply.code === undefined ? 0 : reply.code,
        stdout: reply.stdout ?? '{"ball_id":"ball-1"}\n',
        stderr: reply.stderr ?? "",
        timedOut: reply.timedOut ?? false,
      }
    },
  }
}

const routing = { owner: "@cto", logPath: "/var/log/yrd/runner.log" }

describe("routeOutcome — the registry's disposition IS the switch", () => {
  it("author disposition → the submitter, as a send-back naming ONLY the attributable failures, the log and the re-push command", () => {
    const routed = routeOutcome(outcome(), routing)
    expect(routed.kind).toBe("send-back")
    expect(routed.recipient).toBe("@dev/3")
    expect(routed.fallback).toBe("@cto")
    expect(routed.attributable_test_ids).toEqual(["src/a.ts:12 TS2322 mismatch"])
    expect(routed.command).toBe("yrd pr submit task/thing")
    expect(routed.body).toContain("send back")
    expect(routed.body).toContain("src/a.ts:12 TS2322 mismatch")
    expect(routed.body).toContain(routing.logPath)
    expect(routed.body).toContain("yrd pr submit task/thing")
  })

  it("infra-retry disposition → the queue owner as yrd broken, with the code, the log and the --once command", () => {
    const routed = routeOutcome(outcome({ code: "merge-gitlink-regression", failureKind: "refusal" }), routing)
    expect(routed.kind).toBe("yrd-broken")
    expect(routed.recipient).toBe("@cto")
    expect(routed.disposition).toBe("env")
    expect(routed.body).toContain("[merge-gitlink-regression]")
    expect(routed.body).toContain(routing.logPath)
    expect(routed.command).toBe("yrd queue run --once")
  })

  it("a check TIMEOUT → the owner, and the body says yrd is broken until the owner proves otherwise", () => {
    const routed = routeOutcome(outcome({ kind: "failed", code: "job-lost", failureKind: undefined }), routing)
    expect(routed.kind).toBe("yrd-broken")
    expect(routed.disposition).toBe("timeout")
    expect(routed.recipient).toBe("@cto")
    expect(routed.body).toContain("TIMEOUT")
    expect(routed.body).toContain("until the owner proves otherwise")
  })

  it("an admission classified `infrastructure` → the owner even when the code's bucket would bill the author", () => {
    const routed = routeOutcome(outcome({ failureKind: "infrastructure" }), routing)
    expect(routed.kind).toBe("yrd-broken")
    expect(routed.disposition).toBe("infra")
    expect(routed.recipient).toBe("@cto")
  })

  it("an unregistered code → the owner, named as such, never the author default", () => {
    const routed = routeOutcome(outcome({ code: "no-such-code-anywhere" }), routing)
    expect(routed.kind).toBe("yrd-broken")
    expect(routed.disposition).toBe("unregistered-code")
    expect(routed.recipient).toBe("@cto")
  })

  it("landed → the submitter with the main sha and the close-your-bead instruction", () => {
    const routed = routeOutcome(
      outcome({
        kind: "landed",
        attemptId: "R12",
        run: "R12",
        code: undefined,
        reason: undefined,
        failureKind: undefined,
        attributableFailures: undefined,
        integration: { commit: "c".repeat(40), baseSha: BASE_SHA },
      }),
      routing,
    )
    expect(routed.kind).toBe("landed")
    expect(routed.recipient).toBe("@dev/3")
    expect(routed.body).toContain("c".repeat(40))
    expect(routed.body).toContain("close your bead and retire its lane embed in the same write")
  })

  it("no recorded submitter (or the bay plugin's `operator` default) → the owner, and the body says so", () => {
    for (const submitter of [undefined, "operator", ""]) {
      const routed = routeOutcome(outcome({ submitter }), routing)
      expect(routed.recipient).toBe("@cto")
      expect(routed.disposition).toBe("unknown-submitter")
      expect(routed.body).toContain("No submitter seat was recorded")
    }
  })

  it("`--notify <seat>` recorded beside the submit overrides the revision's submitter", () => {
    const routed = routeOutcome(outcome(), { ...routing, notifySeat: "@dev/9" })
    expect(routed.recipient).toBe("@dev/9")
  })

  it("an empty owner falls back to @chief", () => {
    const routed = routeOutcome(outcome({ failureKind: "infrastructure" }), { owner: "  ", logPath: "x" })
    expect(routed.recipient).toBe(DEFAULT_QUEUE_OWNER)
    expect(DEFAULT_QUEUE_OWNER).toBe("@chief")
  })
})

describe("createOutcomeNotifier — one ball per ended attempt", () => {
  it("hands ONE outcome record to the configured command on stdin and journals the {ball_id} it prints", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "yrd-outcome-"))
    const { calls, commands, run } = fakeRun()
    const { rows, log } = collectingLog()
    const notifier = createOutcomeNotifier({
      stateDir,
      notifyCommand: "bun tools/yrd-notify.ts",
      owner: "@cto",
      logPath: "/log",
      log,
      run,
    })
    const row = await notifier.notify(outcome())
    expect(commands).toEqual(["bun tools/yrd-notify.ts"])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.recipient).toBe("@dev/3")
    expect(calls[0]?.fallback).toBe("@cto")
    expect(row.ball).toBe("ball-1")
    const journaled = readFileSync(join(stateDir, OUTCOME_LEDGER_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(journaled).toHaveLength(1)
    expect(journaled[0]).toMatchObject({ attempt: outcome().attemptId, ball: "ball-1", recipient: "@dev/3" })
    expect(rows.some((entry) => entry.level === "error")).toBe(false)
  })

  it("re-running the same attempt id never sends twice — the journaled ball id is the idempotency key", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "yrd-outcome-"))
    const { calls, run } = fakeRun()
    const { log } = collectingLog()
    const make = () =>
      createOutcomeNotifier({ stateDir, notifyCommand: "notify", owner: "@cto", logPath: "/log", log, run })
    const first = await make().notify(outcome())
    // A SECOND process (fresh notifier, same state dir) sees the journal.
    const second = await make().notify(outcome())
    expect(calls).toHaveLength(1)
    expect(second.ball).toBe(first.ball)
  })

  it("no notify: command → one WARN per pass (notify-unconfigured) and the outcome journaled without a ball", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "yrd-outcome-"))
    const { calls, run } = fakeRun()
    const { rows, log } = collectingLog()
    const notifier = createOutcomeNotifier({ stateDir, owner: "@cto", logPath: "/log", log, run })
    notifier.beginPass()
    const a = await notifier.notify(outcome())
    const b = await notifier.notify(outcome({ attemptId: "R99", kind: "failed" }))
    expect(calls).toHaveLength(0)
    expect(a.ball).toBeUndefined()
    expect(b.ball).toBeUndefined()
    const warns = rows.filter((entry) => entry.level === "warn" && entry.props?.code === "notify-unconfigured")
    expect(warns).toHaveLength(1)
    expect(createOutcomeLedger(stateDir).rows()).toHaveLength(2)
    notifier.beginPass()
    await notifier.notify(outcome({ attemptId: "R100", kind: "failed" }))
    expect(rows.filter((entry) => entry.props?.code === "notify-unconfigured")).toHaveLength(2)
  })

  it.each([
    ["exits non-zero", { code: 3, stdout: "", stderr: "daemon down" }],
    ["prints no ball id", { code: 0, stdout: "sent\n" }],
    ["times out", { code: null, stdout: "", timedOut: true }],
  ])("a notifier that %s → an ERROR row notify-failed, nothing journaled as sent, and a throw (NO SILENT ERRORS)", async (_, reply) => {
    const stateDir = mkdtempSync(join(tmpdir(), "yrd-outcome-"))
    const { run } = fakeRun(reply)
    const { rows, log } = collectingLog()
    const notifier = createOutcomeNotifier({ stateDir, notifyCommand: "notify", owner: "@cto", logPath: "/log", log, run })
    await expect(notifier.notify(outcome())).rejects.toThrow(/notifier/u)
    const errors = rows.filter((entry) => entry.level === "error")
    expect(errors).toHaveLength(1)
    expect(errors[0]?.props?.code).toBe("notify-failed")
    expect(errors[0]?.message).toContain("reached nobody")
    expect(createOutcomeLedger(stateDir).lookup(outcome().attemptId)).toBeUndefined()
  })

  it("the pass's own ERROR row is the owner's ball", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "yrd-outcome-"))
    const { calls, run } = fakeRun()
    const { log } = collectingLog()
    const notifier = createOutcomeNotifier({ stateDir, notifyCommand: "notify", owner: "@cto", logPath: "/log", log, run })
    const row = await notifier.notifyPassError({ namespace: "yrd:queue:compose", message: "boom" }, "pass:r1:t1")
    expect(row.ball).toBe("ball-1")
    expect(calls[0]).toMatchObject({ kind: "yrd-broken", recipient: "@cto", disposition: "pass-error" })
    expect(calls[0]?.body).toContain("yrd:queue:compose")
    expect(calls[0]?.body).toContain("boom")
  })

  it("`queue run --owner` overrides the configured owner for this process", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "yrd-outcome-"))
    const { calls, run } = fakeRun()
    const { log } = collectingLog()
    const notifier = createOutcomeNotifier({ stateDir, notifyCommand: "notify", owner: "@cto", logPath: "/log", log, run })
    notifier.setOwner("@chief")
    await notifier.notify(outcome({ failureKind: "infrastructure" }))
    expect(calls[0]?.recipient).toBe("@chief")
  })

  it("the --notify seat recorded beside the exact (branch, sha) submitted wins the recipient", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "yrd-outcome-"))
    recordNotifySeat(stateDir, { branch: "task/thing", sha: SHA, seat: "@dev/9", at: "t", source: "--notify" })
    expect(lookupNotifySeat(stateDir, "task/thing", SHA)).toBe("@dev/9")
    expect(lookupNotifySeat(stateDir, "task/thing", "f".repeat(40))).toBeUndefined()
    const { calls, run } = fakeRun()
    const { log } = collectingLog()
    const notifier = createOutcomeNotifier({ stateDir, notifyCommand: "notify", owner: "@cto", logPath: "/log", log, run })
    await notifier.notify(outcome())
    expect(calls[0]?.recipient).toBe("@dev/9")
  })
})

describe("the three-way verdict of `queue run --once`", () => {
  it("0 = landed or nothing; 1 = a change sent back; yrd broken = fatal-error (17), and it wins over 1", () => {
    expect(outcomeExitCode([])).toBe(0)
    expect(outcomeExitCode(["landed"])).toBe(0)
    expect(outcomeExitCode(["landed", "send-back"])).toBe(1)
    expect(outcomeExitCode(["send-back", "yrd-broken", "landed"])).toBe(HABITANT_EXIT["fatal-error"])
    expect(QUEUE_OUTCOME_EXIT.yrdFailed).toBe(17)
  })

  it("the notifier accumulates the verdict per pass and beginPass resets it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "yrd-outcome-"))
    const { run } = fakeRun()
    const { log } = collectingLog()
    const notifier = createOutcomeNotifier({ stateDir, notifyCommand: "notify", owner: "@cto", logPath: "/log", log, run })
    notifier.beginPass()
    await notifier.notify(outcome())
    expect(notifier.exitCode()).toBe(QUEUE_OUTCOME_EXIT.changeRefused)
    await notifier.notify(outcome({ attemptId: "R5", kind: "failed", code: "job-lost", failureKind: undefined }))
    expect(notifier.exitCode()).toBe(QUEUE_OUTCOME_EXIT.yrdFailed)
    notifier.beginPass()
    expect(notifier.exitCode()).toBe(QUEUE_OUTCOME_EXIT.next)
  })
})

describe("the seam's small parsers", () => {
  it("parseBallId reads the last JSON line and ignores log noise", () => {
    expect(parseBallId('connecting…\n{"ball_id":"abc"}\n')).toBe("abc")
    expect(parseBallId("{}\n")).toBeUndefined()
    expect(parseBallId("")).toBeUndefined()
  })

  it("the submitter seat comes from the managed seat's launch environment, never argv", () => {
    expect(submitterSeatFromEnvironment({ TRIBE_SESSION_NAME: "@dev/3" })).toEqual({ seat: "@dev/3", source: "env:TRIBE_SESSION_NAME" })
    expect(submitterSeatFromEnvironment({ TRIBE_NAME: "@dev/4" })).toEqual({ seat: "@dev/4", source: "env:TRIBE_NAME" })
    expect(submitterSeatFromEnvironment({ TRIBE_NAME: " " })).toBeUndefined()
    expect(submitterSeatFromEnvironment({})).toBeUndefined()
  })

  it("the notifier bound is 30 s", () => {
    expect(NOTIFY_TIMEOUT_MS).toBe(30_000)
  })
})

describe(".yrd.yml owner: / notify:", () => {
  it("parses both keys and resolves the owner default to @chief", async () => {
    expect(parseYrdConfig({ owner: "@cto", notify: "bun tools/yrd-notify.ts" })).toMatchObject({
      owner: "@cto",
      notify: "bun tools/yrd-notify.ts",
    })
    const declared = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      read: async () => "owner: '@cto'\nnotify: bun tools/yrd-notify.ts\n",
    })
    expect(declared.config.owner).toBe("@cto")
    expect(declared.config.notify).toBe("bun tools/yrd-notify.ts")
    const bare = await loadYrdConfig({ repo: "/repo", defaultBase: "main", read: async () => undefined })
    expect(bare.config.owner).toBe("@chief")
    expect(bare.config.notify).toBeUndefined()
  })
})
