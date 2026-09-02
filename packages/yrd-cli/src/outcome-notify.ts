/**
 * Every queue outcome ends in exactly one ball (@i/10-yrd/24028).
 *
 * The queue hands this module one {@link QueueOutcome} per ENDED attempt; this
 * module decides WHO hears about it and hands ONE outcome record to ONE
 * configured notifier command, which opens the ball and prints its id. The
 * ball id is journaled here, keyed by attempt id, so a re-run of the same
 * attempt never sends twice.
 *
 * Routing is the refusal-code registry's own disposition (`failureDisposition`,
 * read off `COMPOSITION_FAILURE_BUCKETS`), never a second classifier:
 *
 * - landed → the submitter: the main sha, and the instruction to close the
 *   bead and retire its lane embed in the same write.
 * - author disposition (the PR's own attributable failure, base green) → the
 *   submitter: "send back" — the attributable failure ids only, the log path,
 *   the re-push command.
 * - everything else — infra/env disposition, a check TIMEOUT (yrd broken until
 *   the owner proves otherwise), an admission classified `infrastructure`, an
 *   unregistered code, a pass-ending ERROR row — → the queue owner: "yrd
 *   broken" — the code, the log path, the `queue run --once` command.
 * - a submitter nobody recorded routes to the owner too, and the body says so.
 *
 * Layering: yrd stays tribe-free. The notifier is a command named by
 * `.yrd.yml` `notify:`; it reads the outcome JSON on stdin and prints
 * `{ball_id}` on stdout. Absent → one WARN per pass (`notify-unconfigured`)
 * and the outcome is journaled without a ball. Present and failing (non-zero
 * exit, no ball id, 30 s timeout) → an ERROR row (`notify-failed`), which
 * ends the pass under the any-ERROR rule. NO SILENT ERRORS.
 */
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { QueueOutcome } from "@yrd/queue"
import { HABITANT_EXIT } from "./habitant-exit.ts"
import { failureDisposition } from "./status-presentation.ts"

/** Who hears about a yrd fault when nobody configured `owner:`. */
export const DEFAULT_QUEUE_OWNER = "@chief"
/** The recorded submitter when no seat identity reached the submit path. */
export const UNKNOWN_SUBMITTER = "unknown"
/** How long the notifier may take before its silence is a failure. */
export const NOTIFY_TIMEOUT_MS = 30_000
/** State-dir sidecar files. Beside journal.sqlite, OUTSIDE checkpoint-identity
 * state on purpose: a new journal event schema would invalidate every stored
 * checkpoint (see `withQueue`'s note on the checkpoint identity), and a ball
 * id is a fact about a notification, not about the queue's own verdict. */
export const OUTCOME_LEDGER_FILE = "outcome-notifications.jsonl"
export const NOTIFY_SEATS_FILE = "outcome-notify-seats.jsonl"

/** The seam that ends every attempt: the notifier command's stdin. */
export type OutcomeNotification = Readonly<{
  kind: "landed" | "send-back" | "yrd-broken"
  attempt_id: string
  pr: string
  revision: number
  branch: string
  sha: string
  base: string
  code?: string
  disposition: OutcomeDisposition
  attributable_test_ids: readonly string[]
  log_path: string
  /** Who the ball is addressed to. */
  recipient: string
  /** Who takes it when `recipient` is not a live seat. */
  fallback: string
  /** The one command the recipient runs next. */
  command: string
  /** The ball body, ready to send. */
  body: string
}>

export type OutcomeDisposition =
  | "landed"
  | "author"
  | "infra"
  | "env"
  | "timeout"
  | "canceled"
  | "stale"
  | "unregistered-code"
  | "unknown-submitter"
  | "pass-error"

/** The three-way verdict a `queue run --once` process exits with. */
export const QUEUE_OUTCOME_EXIT = Object.freeze({
  /** Every attempt landed, or nothing to do. */
  next: 0,
  /** At least one change was refused and sent back to its submitter; the pass continued. */
  changeRefused: 1,
  /**
   * yrd broke: an infra/env/timeout outcome went to the queue owner, or the
   * pass ended on an ERROR row. The design called this 2; `2` is already the
   * generic usage/configuration exit of every Yrd verb (invocation.ts), and
   * the pass-ending ERROR row already exits `fatal-error` (17) with Hab's
   * stand-down disposition keyed on it, so this is that code — one number
   * for "yrd broke", whichever way it broke. Wins over 1.
   */
  yrdFailed: HABITANT_EXIT["fatal-error"],
} as const)
export type QueueOutcomeExit = (typeof QUEUE_OUTCOME_EXIT)[keyof typeof QUEUE_OUTCOME_EXIT]

/** One journaled notification: facts, never forecasts. `ball` is absent when
 * no notifier was configured — the outcome is still on record. */
export type OutcomeLedgerRow = Readonly<{
  attempt: string
  kind: OutcomeNotification["kind"]
  recipient: string
  disposition: OutcomeDisposition
  at: string
  ball?: string
}>

export type OutcomeLedger = Readonly<{
  lookup(attempt: string): OutcomeLedgerRow | undefined
  append(row: OutcomeLedgerRow): void
  /** Every row, oldest first — what `queue list` prints beside a run. */
  rows(): readonly OutcomeLedgerRow[]
}>

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const rows: T[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    rows.push(JSON.parse(trimmed) as T)
  }
  return rows
}

/** Append-only JSONL beside the journal. Read on every lookup: the file is
 * tiny and another pass may have written since this process started. */
export function createOutcomeLedger(stateDir: string): OutcomeLedger {
  const path = join(stateDir, OUTCOME_LEDGER_FILE)
  return Object.freeze({
    lookup: (attempt) => readJsonl<OutcomeLedgerRow>(path).findLast((row) => row.attempt === attempt),
    append: (row) => {
      mkdirSync(stateDir, { recursive: true })
      appendFileSync(path, `${JSON.stringify(row)}\n`)
    },
    rows: () => readJsonl<OutcomeLedgerRow>(path),
  })
}

/** `pr submit --notify <seat>`: the seat a submission wants its outcome ball
 * addressed to, keyed by the exact (branch, sha) it submitted. A sidecar, for
 * the same checkpoint-identity reason as the ledger — and because the derived
 * lane's submit fact (`branch/submitted`) records no submitter at all. */
export type NotifySeatRow = Readonly<{ branch: string; sha: string; seat: string; at: string; source: string }>

export function recordNotifySeat(stateDir: string, row: NotifySeatRow): void {
  mkdirSync(stateDir, { recursive: true })
  appendFileSync(join(stateDir, NOTIFY_SEATS_FILE), `${JSON.stringify(row)}\n`)
}

export function lookupNotifySeat(stateDir: string, branch: string, sha: string): string | undefined {
  return readJsonl<NotifySeatRow>(join(stateDir, NOTIFY_SEATS_FILE)).findLast(
    (row) => row.branch === branch && row.sha === sha,
  )?.seat
}

/**
 * The seat a submit records when `--notify` is not passed: the managed seat's
 * own name from the environment the daemon/hab launched it with. NEVER argv,
 * cwd, or the git author (operator ruling: "argv is no identity"). A
 * daemon-VALIDATED identity is reachable only through a daemon call, which a
 * tribe-free yrd cannot make; the launch environment's name is the nearest
 * fact this process holds, and its source is recorded beside it.
 */
export function submitterSeatFromEnvironment(
  env: NodeJS.ProcessEnv,
): Readonly<{ seat: string; source: string }> | undefined {
  for (const name of ["TRIBE_SESSION_NAME", "TRIBE_NAME"] as const) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== "") return { seat: value, source: `env:${name}` }
  }
  return undefined
}

export type OutcomeRoutingOptions = Readonly<{
  owner: string
  /** The seat the submission asked to be notified; overrides the recorded submitter. */
  notifySeat?: string
  logPath: string
}>

const CLOSE_BEAD_INSTRUCTION = "close your bead and retire its lane embed in the same write"

/** The recorded submitter, or `unknown` when nothing recorded one. `operator`
 * is the bay plugin's built-in default when no identity reached it — the
 * absence of a seat, not a seat. */
function submitterSeat(outcome: QueueOutcome, options: OutcomeRoutingOptions): string {
  const seat = options.notifySeat ?? outcome.submitter
  if (seat === undefined || seat.trim() === "" || seat === "operator") return UNKNOWN_SUBMITTER
  return seat
}

function classify(outcome: QueueOutcome): Readonly<{ disposition: OutcomeDisposition; owner: "author" | "queue" }> {
  if (outcome.kind === "landed") return { disposition: "landed", owner: "author" }
  // Admission's own classification outranks the code: `infrastructure` is a
  // host fault that already refused to bill the author (checks-survive-one-raise).
  if (outcome.failureKind === "infrastructure") return { disposition: "infra", owner: "queue" }
  if (outcome.code === undefined) return { disposition: "unregistered-code", owner: "queue" }
  let disposition: ReturnType<typeof failureDisposition>
  try {
    disposition = failureDisposition(outcome.code)
  } catch {
    // An unregistered code is a yrd defect (the registry census exists to
    // catch it), never the author's — route it to the owner, and say why.
    return { disposition: "unregistered-code", owner: "queue" }
  }
  if (disposition.owner === "author") return { disposition: "author", owner: "author" }
  if (disposition.state === "timeout") return { disposition: "timeout", owner: "queue" }
  if (disposition.state === "env") return { disposition: "env", owner: "queue" }
  if (disposition.state === "canceled") return { disposition: "canceled", owner: "queue" }
  if (disposition.state === "stale") return { disposition: "stale", owner: "queue" }
  return { disposition: "infra", owner: "queue" }
}

/** ONE routing decision per outcome — the design's switch, on the registry's bucket. */
export function routeOutcome(outcome: QueueOutcome, options: OutcomeRoutingOptions): OutcomeNotification {
  const owner = options.owner.trim() === "" ? DEFAULT_QUEUE_OWNER : options.owner.trim()
  const seat = submitterSeat(outcome, options)
  const classified = classify(outcome)
  const where = `${outcome.pr} rev ${String(outcome.revision)} (${outcome.branch} @ ${outcome.sha.slice(0, 12)}) on ${outcome.base}`
  const attributable = outcome.attributableFailures ?? []
  const base = {
    attempt_id: outcome.attemptId,
    pr: outcome.pr,
    revision: outcome.revision,
    branch: outcome.branch,
    sha: outcome.sha,
    base: outcome.base,
    ...(outcome.code === undefined ? {} : { code: outcome.code }),
    attributable_test_ids: attributable,
    log_path: options.logPath,
    fallback: owner,
  }
  if (classified.disposition === "landed") {
    const landing = outcome.integration?.commit ?? outcome.sha
    const unknown = seat === UNKNOWN_SUBMITTER
    return {
      ...base,
      kind: "landed",
      disposition: unknown ? "unknown-submitter" : "landed",
      recipient: unknown ? owner : seat,
      command: `git log -1 ${landing}`,
      body:
        `landed: ${where} merged as ${landing}` +
        (outcome.integration === undefined ? "" : ` (base ${outcome.integration.baseSha.slice(0, 12)})`) +
        `. ${CLOSE_BEAD_INSTRUCTION}.` +
        (unknown
          ? ` No submitter seat was recorded for this revision (submit with --notify <seat>), so this goes to the queue owner ${owner}.`
          : ""),
    }
  }
  if (classified.owner === "author") {
    const unknown = seat === UNKNOWN_SUBMITTER
    const command = `yrd pr submit ${outcome.branch}`
    const ids = attributable.length === 0 ? "none attributed (see the log)" : attributable.join("; ")
    return {
      ...base,
      kind: "send-back",
      disposition: unknown ? "unknown-submitter" : "author",
      recipient: unknown ? owner : seat,
      command,
      body:
        `send back: ${where} was refused [${outcome.code ?? "?"}] — ${outcome.reason ?? "no reason recorded"}. ` +
        `Attributable failures (yours, base green): ${ids}. Log: ${options.logPath}. ` +
        `Fix, push new content, then: ${command}` +
        (unknown
          ? `. No submitter seat was recorded for this revision (submit with --notify <seat>), so this goes to the queue owner ${owner}.`
          : ""),
    }
  }
  const command = "yrd queue run --once"
  const timeoutNote =
    classified.disposition === "timeout"
      ? " A check TIMEOUT routes here: yrd is broken until the owner proves otherwise."
      : ""
  return {
    ...base,
    kind: "yrd-broken",
    disposition: classified.disposition,
    recipient: owner,
    command,
    body:
      `yrd broken: ${where} ended [${outcome.code ?? "?"}] (${classified.disposition}) — ` +
      `${outcome.reason ?? "no reason recorded"}.${timeoutNote} Log: ${options.logPath}. ` +
      `Re-run: ${command}`,
  }
}

/** A pass-ending ERROR row, as an outcome for the owner. */
export function passErrorNotification(
  fatal: Readonly<{ namespace: string; message: string }>,
  options: Readonly<{ owner: string; logPath: string; attemptId: string }>,
): OutcomeNotification {
  const owner = options.owner.trim() === "" ? DEFAULT_QUEUE_OWNER : options.owner.trim()
  const command = "yrd queue run --once"
  return {
    kind: "yrd-broken",
    attempt_id: options.attemptId,
    pr: "-",
    revision: 0,
    branch: "-",
    sha: "-",
    base: "-",
    disposition: "pass-error",
    attributable_test_ids: [],
    log_path: options.logPath,
    recipient: owner,
    fallback: owner,
    command,
    body:
      `yrd broken: the queue pass stopped on an ERROR from ${fatal.namespace}: ${fatal.message}. ` +
      `Log: ${options.logPath}. Re-run: ${command}`,
  }
}

/** 17 wins over 1 wins over 0. */
export function outcomeExitCode(kinds: readonly OutcomeNotification["kind"][]): QueueOutcomeExit {
  if (kinds.includes("yrd-broken")) return QUEUE_OUTCOME_EXIT.yrdFailed
  if (kinds.includes("send-back")) return QUEUE_OUTCOME_EXIT.changeRefused
  return QUEUE_OUTCOME_EXIT.next
}

export type NotifierRun = (
  command: string,
  input: string,
) => Promise<Readonly<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>>

/** Spawn the configured notifier: JSON on stdin, `{ball_id}` on stdout, 30 s. */
export function spawnNotifier(cwd: string, env: NodeJS.ProcessEnv): NotifierRun {
  return (command, input) =>
    new Promise((resolve) => {
      const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, NOTIFY_TIMEOUT_MS)
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on("error", (error) => {
        clearTimeout(timer)
        resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr, timedOut })
      })
      child.stdin.end(input)
    })
}

export function parseBallId(stdout: string): string | undefined {
  // The last JSON object line wins: a notifier may log above it.
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const parsed = JSON.parse(trimmed) as { ball_id?: unknown }
      if (typeof parsed.ball_id === "string" && parsed.ball_id.trim() !== "") return parsed.ball_id.trim()
    } catch {
      continue
    }
  }
  return undefined
}

type NotifierLog = Readonly<{
  info?: (message: string, props?: Record<string, unknown>) => void
  warn?: (message: string, props?: Record<string, unknown>) => void
  error?: (message: string, props?: Record<string, unknown>) => void
}>

export type OutcomeNotifierOptions = Readonly<{
  stateDir: string
  /** `.yrd.yml` `notify:`; absent means journal-only with one WARN per pass. */
  notifyCommand?: string
  /** `.yrd.yml` `owner:` (default `@chief`); `queue run --owner` overrides per process. */
  owner?: string
  logPath: string
  log: NotifierLog
  run: NotifierRun
  now?: () => number
  ledger?: OutcomeLedger
}>

export type OutcomeNotifier = Readonly<{
  /** Route one ended attempt and open its one ball. Idempotent on attempt id. */
  notify(outcome: QueueOutcome): Promise<OutcomeLedgerRow>
  /** The pass ended on an ERROR row: the owner's ball. */
  notifyPassError(fatal: Readonly<{ namespace: string; message: string }>, attemptId: string): Promise<OutcomeLedgerRow>
  /** `queue run --owner <seat>`. */
  setOwner(seat: string | undefined): void
  owner(): string
  /** Start a pass: the per-pass WARN dedup and the verdict reset. */
  beginPass(): void
  /** The three-way verdict for the outcomes THIS pass produced (17 > 1 > 0). */
  exitCode(): QueueOutcomeExit
  ledger: OutcomeLedger
}>

export function createOutcomeNotifier(options: OutcomeNotifierOptions): OutcomeNotifier {
  const ledger = options.ledger ?? createOutcomeLedger(options.stateDir)
  const now = options.now ?? (() => Date.now())
  let owner = options.owner?.trim() === "" || options.owner === undefined ? DEFAULT_QUEUE_OWNER : options.owner.trim()
  let warnedUnconfigured = false
  const passKinds: OutcomeNotification["kind"][] = []
  const command = options.notifyCommand?.trim()

  const deliver = async (notification: OutcomeNotification): Promise<OutcomeLedgerRow> => {
    const existing = ledger.lookup(notification.attempt_id)
    if (existing !== undefined) {
      options.log.info?.(
        `outcome for attempt '${notification.attempt_id}' already notified` +
          (existing.ball === undefined ? " (journaled without a ball)" : ` as ball ${existing.ball}`) +
          "; not sending again",
        { action: "outcome-already-notified", attempt: notification.attempt_id, ball: existing.ball },
      )
      return existing
    }
    passKinds.push(notification.kind)
    const at = new Date(now()).toISOString()
    if (command === undefined || command === "") {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true
        options.log.warn?.(
          `no notifier is configured (.yrd.yml notify:), so this pass journals outcomes without a ball; ` +
            `${notification.recipient} does not hear about attempt '${notification.attempt_id}' (${notification.kind})`,
          {
            action: "notify-unconfigured",
            code: "notify-unconfigured",
            attempt: notification.attempt_id,
            kind: notification.kind,
            recipient: notification.recipient,
          },
        )
      }
      const row: OutcomeLedgerRow = {
        attempt: notification.attempt_id,
        kind: notification.kind,
        recipient: notification.recipient,
        disposition: notification.disposition,
        at,
      }
      ledger.append(row)
      return row
    }
    const result = await options.run(command, `${JSON.stringify(notification)}\n`)
    const ball = result.code === 0 && !result.timedOut ? parseBallId(result.stdout) : undefined
    if (ball === undefined) {
      const why = result.timedOut
        ? `timed out after ${String(NOTIFY_TIMEOUT_MS)}ms`
        : result.code !== 0
          ? `exited ${String(result.code)}`
          : "printed no {ball_id}"
      options.log.error?.(
        `notifier '${command}' ${why} for attempt '${notification.attempt_id}' (${notification.kind} → ${notification.recipient}); ` +
          `no ball was opened, so the outcome reached nobody: ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
        {
          action: "notify-failed",
          code: "notify-failed",
          attempt: notification.attempt_id,
          kind: notification.kind,
          recipient: notification.recipient,
          exitCode: result.code,
          timedOut: result.timedOut,
          stderr: result.stderr.trim(),
        },
      )
      throw new Error(`yrd: notifier ${why} for attempt '${notification.attempt_id}'`)
    }
    const row: OutcomeLedgerRow = {
      attempt: notification.attempt_id,
      kind: notification.kind,
      recipient: notification.recipient,
      disposition: notification.disposition,
      at,
      ball,
    }
    ledger.append(row)
    options.log.info?.(
      `opened ball ${ball} for attempt '${notification.attempt_id}': ${notification.kind} → ${notification.recipient}`,
      {
        action: "outcome-notified",
        attempt: notification.attempt_id,
        kind: notification.kind,
        recipient: notification.recipient,
        ball,
      },
    )
    return row
  }

  return Object.freeze({
    notify: (outcome) =>
      deliver(
        routeOutcome(outcome, {
          owner,
          logPath: options.logPath,
          ...(() => {
            const seat = lookupNotifySeat(options.stateDir, outcome.branch, outcome.sha)
            return seat === undefined ? {} : { notifySeat: seat }
          })(),
        }),
      ),
    notifyPassError: (fatal, attemptId) =>
      deliver(passErrorNotification(fatal, { owner, logPath: options.logPath, attemptId })),
    setOwner: (seat) => {
      const trimmed = seat?.trim()
      if (trimmed !== undefined && trimmed !== "") owner = trimmed
    },
    owner: () => owner,
    beginPass: () => {
      warnedUnconfigured = false
      passKinds.length = 0
    },
    exitCode: () => outcomeExitCode(passKinds),
    ledger,
  })
}
