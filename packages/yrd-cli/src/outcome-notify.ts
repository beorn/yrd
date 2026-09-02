/**
 * Every queue outcome ends in exactly one ball (@i/10-yrd/24028).
 *
 * The queue hands this module one {@link QueueOutcome} per ENDED attempt; this
 * module decides WHO hears about it and hands ONE outcome record to ONE
 * configured notifier command, which opens the ball and prints its id. The
 * ball id is journaled on the attempt's own row (`queue/attempt/notified` →
 * `queues.outcomes[attempt]`), and that journaled ball IS the idempotency
 * key: a re-run of the same attempt id finds the row and never sends twice.
 * The recipient is the revision's recorded `submitter` (record lane) or the
 * submit fact's `notify` seat (derived lane) — both set by `pr submit
 * --notify`, else the launch-env identity the host reads, else `unknown`.
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
import type { AttemptNotifiedArgs, QueueAttemptOutcome, QueueOutcome } from "@yrd/queue"
import { failureDisposition } from "./status-presentation.ts"

/** Who hears about a yrd fault when nobody configured `owner:`. */
export const DEFAULT_QUEUE_OWNER = "@chief"
/** The recorded submitter when no seat identity reached the submit path. */
export const UNKNOWN_SUBMITTER = "unknown"
/** How long the notifier may take before its silence is a failure. */
export const NOTIFY_TIMEOUT_MS = 30_000
/** The launch-environment identity the host already reads as the default
 * submitter of every record it writes (`YRD_DEFAULT_SUBMITTER`). It is the
 * one identity a submit may default to: never argv, cwd or the git author. */
export const YRD_DEFAULT_SUBMITTER_ENV = "YRD_DEFAULT_SUBMITTER" as const

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
  /**
   * The queue has eligible work this runner has stopped draining — a HEALTH
   * observation about the service, not a verdict on any one change. It reached
   * the owner as an ERROR row until 2026-09-02, which under the any-ERROR rule
   * killed the runner that was reporting it; it is a page now, and the runner
   * keeps running (@i/10-yrd/liveness-is-health).
   */
  | "queue-wedged"

/** The three-way result a `queue run --once` process exits with: pass, fail, stuck. */
export const QUEUE_OUTCOME_EXIT = Object.freeze({
  /** Every attempt landed, or nothing to do. */
  next: 0,
  /** At least one change was refused and sent back to its submitter; the pass continued. */
  changeRefused: 1,
  /**
   * STUCK: the queue could not do its job — a stuck check, an infra/env/timeout
   * outcome that went to the queue owner, or a pass that ended on an ERROR row.
   * Nobody is billed and the change stays where it was. Wins over 1.
   *
   * 2, by operator ruling 2026-09-02. This spent 17 until then, on the
   * reasoning that `2` is already the generic usage/configuration exit of every
   * Yrd verb (invocation.ts) and so could not also mean this. The ruling
   * settles it the other way: a bad invocation of the queue run is ITSELF a way
   * for the queue to be stuck, so the two readings agree and the collision is
   * accepted. 17 is retired here; `HABITANT_EXIT["fatal-error"]` keeps it for
   * the habitant lifecycle condition it names, which is a different contract
   * with a different reader (Hab's stand-down disposition).
   */
  yrdFailed: 2,
} as const)
export type QueueOutcomeExit = (typeof QUEUE_OUTCOME_EXIT)[keyof typeof QUEUE_OUTCOME_EXIT]

/** One journaled notification, as the queue projects it: facts, never
 * forecasts. `ball` is absent when no notifier was configured — the outcome is
 * still on record, and nobody holds a ball for it. */
export type OutcomeLedgerRow = QueueAttemptOutcome

/** The attempt rows, read and written through the journal — never a sidecar.
 * `lookup` reads the projection; `append` dispatches `queue/attempt/notified`,
 * which the queue projects onto the attempt's row and refuses to duplicate. */
export type OutcomeLedger = Readonly<{
  lookup(attempt: string): OutcomeLedgerRow | undefined
  append(row: AttemptNotifiedArgs): Promise<void>
  /** Every row, oldest first — what `queue list` prints beneath the timeline. */
  rows(): readonly OutcomeLedgerRow[]
}>

/** What the ledger needs from the runtime app: the projected attempt rows and
 * the command that journals one. Handed in lazily because the notifier is
 * built before the app it reads (the queue's hook needs the notifier first). */
export type OutcomeJournal = Readonly<{
  outcomes(): Readonly<Record<string, QueueAttemptOutcome>>
  noteAttemptOutcome(args: AttemptNotifiedArgs): Promise<unknown>
}>

export function createJournalOutcomeLedger(journal: () => OutcomeJournal): OutcomeLedger {
  return Object.freeze({
    lookup: (attempt) => journal().outcomes()[attempt],
    append: async (row) => {
      await journal().noteAttemptOutcome(row)
    },
    rows: () => Object.values(journal().outcomes()).sort((left, right) => left.at.localeCompare(right.at)),
  })
}

/**
 * The seat a submit records when `--notify` is not passed: the launch-env
 * identity the host already reads for every record it writes
 * ({@link YRD_DEFAULT_SUBMITTER_ENV}). NEVER argv, cwd, or the git author
 * (operator ruling: "argv is no identity"). Absent, the submit records the
 * literal `unknown`, and unknown routes to the queue owner with "submitter
 * unknown" in the ball body — nobody invents an identity.
 */
export function submitterSeatFromEnvironment(
  env: NodeJS.ProcessEnv,
): Readonly<{ seat: string; source: string }> | undefined {
  const value = env[YRD_DEFAULT_SUBMITTER_ENV]?.trim()
  if (value !== undefined && value !== "") return { seat: value, source: `env:${YRD_DEFAULT_SUBMITTER_ENV}` }
  return undefined
}

/** The seat a submit records, and where it came from: `--notify` first, else
 * the launch-env identity, else `unknown` (source `none`). */
export function resolveSubmitterSeat(
  notify: string | undefined,
  env: NodeJS.ProcessEnv,
): Readonly<{ seat: string; source: string }> {
  const explicit = notify?.trim()
  if (explicit !== undefined && explicit !== "") return { seat: explicit, source: "--notify" }
  return submitterSeatFromEnvironment(env) ?? { seat: UNKNOWN_SUBMITTER, source: "none" }
}

export type OutcomeRoutingOptions = Readonly<{
  owner: string
  logPath: string
}>

const CLOSE_BEAD_INSTRUCTION = "close your bead and retire its lane embed in the same write"

/** The recorded submitter, or `unknown` when nothing recorded one. `operator`
 * is the bay plugin's built-in default when no identity reached it — the
 * absence of a seat, not a seat. */
function submitterSeat(outcome: QueueOutcome): string {
  const seat = outcome.submitter
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
  const seat = submitterSeat(outcome)
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

/** What a wedge page needs to name the condition it is paging about. */
export type QueueWedgeInput = Readonly<{
  /** The queue this is about. */
  base: string
  /** The audit finding's own message — the count, the span, the head change. */
  message: string
  /** The head-of-line change, when the finding named one. */
  pr?: string
  /** How long the runner has observed no merge, by ITS OWN clock. */
  blockedMs?: number
  /** How many announcements of this condition have gone out, this one included. */
  generation: number
}>

/**
 * A queue this runner has stopped draining, as a page for its owner.
 *
 * `yrd-broken` like every other owner-bound outcome — nobody but the owner can
 * act on it — but it carries no attempt, no revision and no verdict, because
 * no change was tried and none is being blamed. The body says the runner is
 * still up, which is the fact that changes what the owner does next: before
 * this, the same condition arrived as the runner's death certificate.
 */
export function queueWedgedNotification(
  wedge: QueueWedgeInput,
  options: Readonly<{ owner: string; logPath: string; attemptId: string }>,
): OutcomeNotification {
  const owner = options.owner.trim() === "" ? DEFAULT_QUEUE_OWNER : options.owner.trim()
  const command = "yrd queue audit"
  return {
    kind: "yrd-broken",
    attempt_id: options.attemptId,
    pr: wedge.pr ?? "-",
    revision: 0,
    branch: "-",
    sha: "-",
    base: wedge.base,
    attributable_test_ids: [],
    disposition: "queue-wedged",
    log_path: options.logPath,
    recipient: owner,
    fallback: owner,
    command,
    body:
      `yrd wedged: ${wedge.message} The runner is still running and still trying; this is a health page, ` +
      `not a stop (notice ${String(wedge.generation)}). Log: ${options.logPath}. Next: ${command}`,
  }
}

/** Stuck (2) wins over fail (1) wins over pass (0). */
export function outcomeExitCode(kinds: readonly OutcomeNotification["kind"][]): QueueOutcomeExit {
  if (kinds.includes("yrd-broken")) return QUEUE_OUTCOME_EXIT.yrdFailed
  if (kinds.includes("send-back")) return QUEUE_OUTCOME_EXIT.changeRefused
  return QUEUE_OUTCOME_EXIT.next
}

/** One message this pass sent: who heard it, and what it said. The ball id is
 * added when the notifier opened one; absent means the outcome was journaled
 * with nobody holding it, which the WARN above already says out loud. */
export type QueuePassMessage = Readonly<{
  attempt: string
  kind: OutcomeNotification["kind"]
  recipient: string
  disposition: OutcomeDisposition
  ball?: string
}>

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
  /** The attempt rows, through the journal (`createJournalOutcomeLedger`). */
  ledger: OutcomeLedger
  /** `.yrd.yml` `notify:`; absent means journal-only with one WARN per pass. */
  notifyCommand?: string
  /** `.yrd.yml` `owner:` (default `@chief`); `queue run --owner` overrides per process. */
  owner?: string
  logPath: string
  log: NotifierLog
  run: NotifierRun
}>

export type OutcomeNotifier = Readonly<{
  /** Route one ended attempt and open its one ball. Idempotent on attempt id. */
  notify(outcome: QueueOutcome): Promise<OutcomeLedgerRow>
  /** The pass ended on an ERROR row: the owner's ball. */
  notifyPassError(fatal: Readonly<{ namespace: string; message: string }>, attemptId: string): Promise<OutcomeLedgerRow>
  /**
   * The queue is wedged and the runner is still up: the owner's ball, ADVISORY.
   *
   * Advisory is the whole point and is not a softening. Every other outcome
   * here belongs to a pass that has already ended, so a notifier that fails
   * may raise an ERROR and end it again harmlessly. This one belongs to a pass
   * that is still running, and this bead exists because a health observation
   * about that pass was killing it — so a failure to DELIVER the observation
   * must not kill it either, or the fault walks back in through the notifier
   * door. It resolves `undefined` instead: WARN, no ball journaled, and the
   * next generation tries again. Not silent — the WARN names the notifier, the
   * exit and the recipient who did not hear.
   */
  notifyQueueWedged(wedge: QueueWedgeInput, attemptId: string): Promise<OutcomeLedgerRow | undefined>
  /** `queue run --owner <seat>`. */
  setOwner(seat: string | undefined): void
  owner(): string
  /** Start a pass: the per-pass WARN dedup and the verdict reset. */
  beginPass(): void
  /** The three-way result for the outcomes THIS pass produced (2 > 1 > 0). */
  exitCode(): QueueOutcomeExit
  /** What THIS pass told whom, in order — the queue run log's `message` records. */
  passMessages(): readonly QueuePassMessage[]
  ledger: OutcomeLedger
}>

export function createOutcomeNotifier(options: OutcomeNotifierOptions): OutcomeNotifier {
  const ledger = options.ledger
  let owner = options.owner?.trim() === "" || options.owner === undefined ? DEFAULT_QUEUE_OWNER : options.owner.trim()
  let warnedUnconfigured = false
  const passKinds: OutcomeNotification["kind"][] = []
  /** What this pass told whom, in order — the `message` records of the queue
   * run's log (@i/10-yrd/plan.md § Log). Collected HERE because this is the one
   * place a message is sent, so the log can never name a recipient the notifier
   * did not write to. Reset by `beginPass` with the kinds. */
  const passMessages: QueuePassMessage[] = []
  const command = options.notifyCommand?.trim()

  /** Journal the row on the attempt, then read it back: the projection is the
   * fact of record, and a row that did not project is a loud error, never a
   * ball that reads as journaled. */
  const journalRow = async (args: AttemptNotifiedArgs): Promise<OutcomeLedgerRow> => {
    await ledger.append(args)
    const journaled = ledger.lookup(args.attempt)
    if (journaled === undefined) {
      throw new Error(
        `yrd: attempt '${args.attempt}' was notified but its row did not project into the journal (queue/attempt/notified)`,
      )
    }
    return journaled
  }
  /**
   * Deliver one notification whose pass is STILL RUNNING.
   *
   * The delivery mechanics are `deliver`'s, minus the two things that only
   * make sense for an ended attempt: the failure is a WARN rather than an
   * ERROR (it must not end the live pass — see `notifyQueueWedged`), and the
   * kind is kept out of `passKinds` so a health page cannot turn a clean
   * one-shot verdict into `yrd broke`.
   */
  const deliverAdvisory = async (notification: OutcomeNotification): Promise<OutcomeLedgerRow | undefined> => {
    const existing = ledger.lookup(notification.attempt_id)
    if (existing !== undefined) return existing
    if (command === undefined || command === "") {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true
        options.log.warn?.(
          `no notifier is configured (.yrd.yml notify:), so this pass journals outcomes without a ball; ` +
            `${notification.recipient} does not hear about '${notification.attempt_id}' (${notification.disposition})`,
          {
            action: "notify-unconfigured",
            code: "notify-unconfigured",
            attempt: notification.attempt_id,
            kind: notification.kind,
            recipient: notification.recipient,
          },
        )
      }
      return journalRow({
        attempt: notification.attempt_id,
        kind: notification.kind,
        recipient: notification.recipient,
        disposition: notification.disposition,
      })
    }
    const result = await options.run(command, `${JSON.stringify(notification)}\n`)
    const ball = result.code === 0 && !result.timedOut ? parseBallId(result.stdout) : undefined
    if (ball === undefined) {
      const why = result.timedOut
        ? `timed out after ${String(NOTIFY_TIMEOUT_MS)}ms`
        : result.code !== 0
          ? `exited ${String(result.code)}`
          : "printed no {ball_id}"
      options.log.warn?.(
        `notifier '${command}' ${why} for the advisory '${notification.attempt_id}' (${notification.disposition} → ` +
          `${notification.recipient}); no ball was opened, so nobody heard this notice — the runner keeps running and ` +
          `the next one retries: ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
        {
          action: "notify-advisory-failed",
          code: "notify-advisory-failed",
          attempt: notification.attempt_id,
          kind: notification.kind,
          disposition: notification.disposition,
          recipient: notification.recipient,
          exitCode: result.code,
          timedOut: result.timedOut,
          stderr: result.stderr.trim(),
        },
      )
      return undefined
    }
    const row = await journalRow({
      attempt: notification.attempt_id,
      kind: notification.kind,
      recipient: notification.recipient,
      disposition: notification.disposition,
      ball,
    })
    options.log.info?.(
      `opened ball ${ball} for '${notification.attempt_id}': ${notification.disposition} → ${notification.recipient}`,
      {
        action: "outcome-notified",
        attempt: notification.attempt_id,
        kind: notification.kind,
        disposition: notification.disposition,
        recipient: notification.recipient,
        ball,
      },
    )
    return row
  }

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
    passMessages.push({
      attempt: notification.attempt_id,
      kind: notification.kind,
      recipient: notification.recipient,
      disposition: notification.disposition,
    })
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
      return journalRow({
        attempt: notification.attempt_id,
        kind: notification.kind,
        recipient: notification.recipient,
        disposition: notification.disposition,
      })
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
    const row = await journalRow({
      attempt: notification.attempt_id,
      kind: notification.kind,
      recipient: notification.recipient,
      disposition: notification.disposition,
      ball,
    })
    // The ball is known only now, so the message row this pass already recorded
    // is completed here rather than re-pushed: one message sent is one row.
    const pending = passMessages.findIndex((message) => message.attempt === notification.attempt_id)
    if (pending >= 0) passMessages[pending] = { ...passMessages[pending]!, ball }
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
    notify: (outcome) => deliver(routeOutcome(outcome, { owner, logPath: options.logPath })),
    notifyPassError: (fatal, attemptId) =>
      deliver(passErrorNotification(fatal, { owner, logPath: options.logPath, attemptId })),
    notifyQueueWedged: (wedge, attemptId) =>
      deliverAdvisory(queueWedgedNotification(wedge, { owner, logPath: options.logPath, attemptId })),
    setOwner: (seat) => {
      const trimmed = seat?.trim()
      if (trimmed !== undefined && trimmed !== "") owner = trimmed
    },
    owner: () => owner,
    beginPass: () => {
      warnedUnconfigured = false
      passKinds.length = 0
      passMessages.length = 0
    },
    exitCode: () => outcomeExitCode(passKinds),
    passMessages: () => [...passMessages],
    ledger,
  })
}
