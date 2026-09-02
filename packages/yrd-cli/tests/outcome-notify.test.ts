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
import { describe, expect, it } from "vitest"
import type { AttemptNotifiedArgs, QueueAttemptOutcome, QueueOutcome } from "@yrd/queue"
import { loadYrdConfig, parseYrdConfig } from "../src/config.ts"
import { HABITANT_EXIT } from "../src/habitant-exit.ts"
import {
  createJournalOutcomeLedger,
  createOutcomeNotifier,
  DEFAULT_QUEUE_OWNER,
  NOTIFY_TIMEOUT_MS,
  outcomeExitCode,
  parseBallId,
  passErrorNotification,
  QUEUE_OUTCOME_EXIT,
  resolveSubmitterSeat,
  routeOutcome,
  submitterSeatFromEnvironment,
  UNKNOWN_SUBMITTER,
  YRD_DEFAULT_SUBMITTER_ENV,
  type NotifierRun,
  type OutcomeLedger,
  type OutcomeNotification,
} from "../src/outcome-notify.ts"

/** A journal stand-in with the queue's own semantics: `queue/attempt/notified`
 * projects onto the attempt's row, the first row stands, `at` is the frame's
 * timestamp. Shared across notifiers the way one journal is shared across
 * processes. */
function journal(): Readonly<{
  rows: Record<string, QueueAttemptOutcome>
  noted: AttemptNotifiedArgs[]
  ledger: OutcomeLedger
}> {
  const rows: Record<string, QueueAttemptOutcome> = {}
  const noted: AttemptNotifiedArgs[] = []
  let tick = 0
  const ledger = createJournalOutcomeLedger(() => ({
    outcomes: () => rows,
    noteAttemptOutcome: async (args) => {
      noted.push(args)
      if (rows[args.attempt] !== undefined) return
      rows[args.attempt] = { ...args, at: `2026-09-01T00:00:0${String(tick++)}.000Z` }
    },
  }))
  return { rows, noted, ledger }
}

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

  /**
   * PR3221's ball read `merged as 27fc05023a3d9e7575a0491b1806ae75dcd00616
   * (base 27fc05023a3d)` — a commit announced as its own base. The proof's
   * `baseSha` is the base tip AFTER landing, which for an ordinary merge IS the
   * merge commit; the base the checks ran at (27fc0502's first parent, 7f4f3305)
   * lives on the member. The ball now names the merge and what it landed onto.
   */
  it("landed → merged as <merge> onto <pre-merge base>, never the merge as its own base", () => {
    const merge = "c".repeat(40)
    const routed = routeOutcome(
      outcome({
        kind: "landed",
        attemptId: "R12",
        run: "R12",
        code: undefined,
        reason: undefined,
        failureKind: undefined,
        attributableFailures: undefined,
        // The live shape: the proof's baseSha IS the merge commit.
        integration: { commit: merge, baseSha: merge },
        baseSha: BASE_SHA,
      }),
      routing,
    )
    expect(routed.body).toContain(`merged as ${merge} onto ${BASE_SHA.slice(0, 12)}`)
    expect(routed.body).not.toContain(`onto ${merge.slice(0, 12)}`)
    expect(routed.body, "the old shape said (base …) and named the merge itself").not.toContain("(base ")
  })

  it("landed with no recorded base says nothing rather than inventing one", () => {
    const routed = routeOutcome(
      outcome({
        kind: "landed",
        attemptId: "R12",
        run: "R12",
        code: undefined,
        reason: undefined,
        failureKind: undefined,
        attributableFailures: undefined,
        integration: { commit: "c".repeat(40), baseSha: "c".repeat(40) },
        baseSha: undefined,
      }),
      routing,
    )
    expect(routed.body).toContain(`merged as ${"c".repeat(40)}.`)
    expect(routed.body).not.toContain("onto")
  })

  /**
   * Every yrd-broken ball printed `do: yrd queue run --once` / `Re-run: yrd
   * queue run --once` unconditionally, including on the live queue a resident
   * (pid 2718014) was following on 2026-09-02. A reader who obeys starts a
   * second writer on the resident's journal.
   */
  describe("a broken ball never hands out `queue run --once` beside a resident (L5)", () => {
    const broken = outcome({ code: "check-storage-exhausted", branch: "task/thing" })

    it("with a resident: names it, says it re-drives, and forbids the second writer", () => {
      const routed = routeOutcome(broken, { ...routing, resident: "yrd-cli:2718014" })
      expect(routed.kind).toBe("yrd-broken")
      expect(routed.command).toBe("yrd pr submit task/thing")
      expect(routed.body).toContain("The resident runner yrd-cli:2718014 is following this queue")
      expect(routed.body).toContain("re-drives it on its next pass")
      expect(routed.body).toContain("do NOT run 'yrd queue run --once' beside it")
      expect(routed.body).toContain("To force it now: yrd pr submit task/thing")
    })

    it("with NO resident: `--once` is exactly right and is still offered", () => {
      const routed = routeOutcome(broken, routing)
      expect(routed.command).toBe("yrd queue run --once")
      expect(routed.body).toContain("Re-run: yrd queue run --once")
      expect(routed.body).not.toContain("resident runner")
    })

    it("a pass error belongs to no branch, so a resident leaves nothing to force", () => {
      const options = { owner: "@cto", logPath: "/tmp/yrd.log", attemptId: "pass-1" }
      const withResident = passErrorNotification({ namespace: "yrd:queue", message: "boom" }, {
        ...options,
        resident: "yrd-cli:2718014",
      })
      expect(withResident.body).toContain("re-drives it on its next pass")
      expect(withResident.body).not.toContain("Re-run: yrd queue run --once")

      const alone = passErrorNotification({ namespace: "yrd:queue", message: "boom" }, options)
      expect(alone.body).toContain("Re-run: yrd queue run --once")
    })
  })

  it("no recorded submitter (the literal `unknown`, or the bay plugin's `operator` default) → the owner, and the body says so", () => {
    for (const submitter of [undefined, "operator", "", UNKNOWN_SUBMITTER]) {
      const routed = routeOutcome(outcome({ submitter }), routing)
      expect(routed.recipient).toBe("@cto")
      expect(routed.disposition).toBe("unknown-submitter")
      expect(routed.body).toContain("No submitter seat was recorded")
    }
  })

  it("the revision's journaled submitter IS the recipient — `pr submit --notify` sets it, no sidecar overrides it", () => {
    const routed = routeOutcome(outcome({ submitter: "@dev/9" }), routing)
    expect(routed.recipient).toBe("@dev/9")
  })

  it("an empty owner falls back to @chief", () => {
    const routed = routeOutcome(outcome({ failureKind: "infrastructure" }), { owner: "  ", logPath: "x" })
    expect(routed.recipient).toBe(DEFAULT_QUEUE_OWNER)
    expect(DEFAULT_QUEUE_OWNER).toBe("@chief")
  })
})

describe("createOutcomeNotifier — one ball per ended attempt", () => {
  it("hands ONE outcome record to the configured command on stdin and journals the {ball_id} it prints ON THE ATTEMPT ROW", async () => {
    const { rows: attempts, noted, ledger } = journal()
    const { calls, commands, run } = fakeRun()
    const { rows, log } = collectingLog()
    const notifier = createOutcomeNotifier({
      ledger,
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
    // The journal, not a sidecar: one queue/attempt/notified for this attempt id.
    expect(noted).toEqual([
      { attempt: outcome().attemptId, kind: "send-back", recipient: "@dev/3", disposition: "author", ball: "ball-1" },
    ])
    expect(attempts[outcome().attemptId]).toMatchObject({ ball: "ball-1", recipient: "@dev/3" })
    expect(row).toEqual(attempts[outcome().attemptId])
    expect(rows.some((entry) => entry.level === "error")).toBe(false)
  })

  it("re-running the same attempt id never sends twice — the journaled ball id on the attempt row is the idempotency key", async () => {
    const { ledger } = journal()
    const { calls, run } = fakeRun()
    const { log } = collectingLog()
    const make = () =>
      createOutcomeNotifier({ ledger, notifyCommand: "notify", owner: "@cto", logPath: "/log", log, run })
    const first = await make().notify(outcome())
    // A SECOND process (fresh notifier, same journal) finds the row.
    const second = await make().notify(outcome())
    expect(calls).toHaveLength(1)
    expect(second.ball).toBe(first.ball)
  })

  it("a row that did not project is a loud error, never a ball that reads as journaled (NO SILENT ERRORS)", async () => {
    const dark = createJournalOutcomeLedger(() => ({ outcomes: () => ({}), noteAttemptOutcome: async () => undefined }))
    const { run } = fakeRun()
    const { log } = collectingLog()
    const notifier = createOutcomeNotifier({
      ledger: dark,
      notifyCommand: "notify",
      owner: "@cto",
      logPath: "/log",
      log,
      run,
    })
    await expect(notifier.notify(outcome())).rejects.toThrow(/did not project/u)
  })

  it("no notify: command → one WARN per pass (notify-unconfigured) and the outcome journaled without a ball", async () => {
    const { ledger } = journal()
    const { calls, run } = fakeRun()
    const { rows, log } = collectingLog()
    const notifier = createOutcomeNotifier({ ledger, owner: "@cto", logPath: "/log", log, run })
    notifier.beginPass()
    const a = await notifier.notify(outcome())
    const b = await notifier.notify(outcome({ attemptId: "R99", kind: "failed" }))
    expect(calls).toHaveLength(0)
    expect(a.ball).toBeUndefined()
    expect(b.ball).toBeUndefined()
    const warns = rows.filter((entry) => entry.level === "warn" && entry.props?.code === "notify-unconfigured")
    expect(warns).toHaveLength(1)
    expect(ledger.rows()).toHaveLength(2)
    expect(ledger.rows().map((row) => row.attempt)).toEqual([outcome().attemptId, "R99"])
    notifier.beginPass()
    await notifier.notify(outcome({ attemptId: "R100", kind: "failed" }))
    expect(rows.filter((entry) => entry.props?.code === "notify-unconfigured")).toHaveLength(2)
  })

  it.each([
    ["exits non-zero", { code: 3, stdout: "", stderr: "daemon down" }],
    ["prints no ball id", { code: 0, stdout: "sent\n" }],
    ["times out", { code: null, stdout: "", timedOut: true }],
  ])(
    "a notifier that %s → an ERROR row notify-failed, nothing journaled as sent, and a throw (NO SILENT ERRORS)",
    async (_, reply) => {
      const { ledger } = journal()
      const { run } = fakeRun(reply)
      const { rows, log } = collectingLog()
      const notifier = createOutcomeNotifier({
        ledger,
        notifyCommand: "notify",
        owner: "@cto",
        logPath: "/log",
        log,
        run,
      })
      await expect(notifier.notify(outcome())).rejects.toThrow(/notifier/u)
      const errors = rows.filter((entry) => entry.level === "error")
      expect(errors).toHaveLength(1)
      expect(errors[0]?.props?.code).toBe("notify-failed")
      expect(errors[0]?.message).toContain("reached nobody")
      expect(ledger.lookup(outcome().attemptId)).toBeUndefined()
    },
  )

  it("the pass's own ERROR row is the owner's ball", async () => {
    const { ledger } = journal()
    const { calls, run } = fakeRun()
    const { log } = collectingLog()
    const notifier = createOutcomeNotifier({
      ledger,
      notifyCommand: "notify",
      owner: "@cto",
      logPath: "/log",
      log,
      run,
    })
    const row = await notifier.notifyPassError({ namespace: "yrd:queue:compose", message: "boom" }, "pass:r1:t1")
    expect(row.ball).toBe("ball-1")
    expect(calls[0]).toMatchObject({ kind: "yrd-broken", recipient: "@cto", disposition: "pass-error" })
    expect(calls[0]?.body).toContain("yrd:queue:compose")
    expect(calls[0]?.body).toContain("boom")
  })

  /**
   * The wedge page (@i/10-yrd/liveness-is-health), and why it is ADVISORY.
   *
   * Every other outcome here belongs to a pass that has already ended, so a
   * notifier that fails may raise an ERROR and end it again harmlessly. This
   * one belongs to a pass that is STILL RUNNING, and this bead exists because a
   * health observation about that pass was killing it. A failure to deliver the
   * observation must not kill it either, or the fault walks straight back in
   * through the notifier door.
   */
  describe("a wedged queue whose runner is still up", () => {
    const wedge = {
      base: "main",
      message: "Queue 'main' has 4 eligible changes outstanding and no merge for 1h25m",
      pr: "PR7",
      blockedMs: 5_100_000,
      generation: 2,
    }

    it("pages the owner, naming the queue and saying the runner is still running", async () => {
      const { ledger } = journal()
      const { calls, run } = fakeRun()
      const { rows, log } = collectingLog()
      const notifier = createOutcomeNotifier({
        ledger,
        notifyCommand: "notify",
        owner: "@cto",
        logPath: "/log",
        log,
        run,
      })

      const row = await notifier.notifyQueueWedged(wedge, "wedge:main:2")

      expect(row?.ball).toBe("ball-1")
      expect(calls[0]).toMatchObject({
        kind: "yrd-broken",
        recipient: "@cto",
        disposition: "queue-wedged",
        base: "main",
      })
      // The fact that changes what the owner does next: before this, the same
      // condition arrived as the runner's death certificate.
      expect(calls[0]?.body).toContain("still running")
      expect(calls[0]?.body).toContain("notice 2")
      expect(rows.some((entry) => entry.level === "error")).toBe(false)
    })

    it("a FAILING notifier warns and resolves undefined — it never raises the ERROR that would end the live pass", async () => {
      const { ledger } = journal()
      const { run } = fakeRun({ code: 1, stderr: "no tribe daemon" })
      const { rows, log } = collectingLog()
      const notifier = createOutcomeNotifier({
        ledger,
        notifyCommand: "notify",
        owner: "@cto",
        logPath: "/log",
        log,
        run,
      })

      // CONTROL: the ended-attempt path on the SAME failing notifier still
      // throws and still raises ERROR, so the quiet below is this call's
      // disposition and not a broken double.
      await expect(notifier.notify(outcome())).rejects.toThrow(/notifier/u)
      expect(rows.filter((entry) => entry.level === "error")).toHaveLength(1)

      await expect(notifier.notifyQueueWedged(wedge, "wedge:main:2")).resolves.toBeUndefined()

      // Still exactly the one ERROR from the control above: the advisory added none.
      expect(rows.filter((entry) => entry.level === "error")).toHaveLength(1)
      const warned = rows.filter((entry) => entry.props?.code === "notify-advisory-failed")
      expect(warned).toHaveLength(1)
      expect(warned[0]?.level).toBe("warn")
      // NO SILENT ERRORS: who did not hear, and why.
      expect(warned[0]?.message).toContain("@cto")
      expect(warned[0]?.message).toContain("no tribe daemon")
      // Nothing journaled, so the next generation is free to try again.
      expect(ledger.lookup("wedge:main:2")).toBeUndefined()
    })

    it("never contributes to the pass verdict — a health page cannot turn a clean one-shot into `yrd broke`", async () => {
      const { ledger } = journal()
      const { run } = fakeRun()
      const { log } = collectingLog()
      const notifier = createOutcomeNotifier({
        ledger,
        notifyCommand: "notify",
        owner: "@cto",
        logPath: "/log",
        log,
        run,
      })
      notifier.beginPass()

      await notifier.notifyQueueWedged(wedge, "wedge:main:2")

      expect(notifier.exitCode()).toBe(QUEUE_OUTCOME_EXIT.next)
    })
  })

  it("`queue run --owner` overrides the configured owner for this process", async () => {
    const { ledger } = journal()
    const { calls, run } = fakeRun()
    const { log } = collectingLog()
    const notifier = createOutcomeNotifier({
      ledger,
      notifyCommand: "notify",
      owner: "@cto",
      logPath: "/log",
      log,
      run,
    })
    notifier.setOwner("@chief")
    await notifier.notify(outcome({ failureKind: "infrastructure" }))
    expect(calls[0]?.recipient).toBe("@chief")
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
    const { ledger } = journal()
    const { run } = fakeRun()
    const { log } = collectingLog()
    const notifier = createOutcomeNotifier({
      ledger,
      notifyCommand: "notify",
      owner: "@cto",
      logPath: "/log",
      log,
      run,
    })
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

  it("the default submitter seat is the launch-env identity the host already reads (YRD_DEFAULT_SUBMITTER), never argv, cwd or the git author", () => {
    expect(YRD_DEFAULT_SUBMITTER_ENV).toBe("YRD_DEFAULT_SUBMITTER")
    expect(submitterSeatFromEnvironment({ YRD_DEFAULT_SUBMITTER: "@dev/3" })).toEqual({
      seat: "@dev/3",
      source: "env:YRD_DEFAULT_SUBMITTER",
    })
    expect(submitterSeatFromEnvironment({ YRD_DEFAULT_SUBMITTER: " " })).toBeUndefined()
    expect(submitterSeatFromEnvironment({ TRIBE_SESSION_NAME: "@dev/3", TRIBE_NAME: "@dev/3" })).toBeUndefined()
    expect(submitterSeatFromEnvironment({})).toBeUndefined()
  })

  it("resolveSubmitterSeat: --notify first, else the launch-env identity, else the literal `unknown` with its source", () => {
    expect(resolveSubmitterSeat("@dev/9", { YRD_DEFAULT_SUBMITTER: "@dev/3" })).toEqual({
      seat: "@dev/9",
      source: "--notify",
    })
    expect(resolveSubmitterSeat("  ", { YRD_DEFAULT_SUBMITTER: "@dev/3" })).toEqual({
      seat: "@dev/3",
      source: "env:YRD_DEFAULT_SUBMITTER",
    })
    expect(resolveSubmitterSeat(undefined, {})).toEqual({ seat: UNKNOWN_SUBMITTER, source: "none" })
    expect(UNKNOWN_SUBMITTER).toBe("unknown")
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
