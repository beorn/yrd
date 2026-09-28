/** The runner ref is an observed health claim, never a lease or authority. */
import { assertBranch, parseChangeName } from "./refs.ts"

/** Live runner phases shared by the wire, CLI, and human views. */
export const RUNNER_STATES = [
  "idle",
  "provisioning",
  "checking",
  "merging",
  "deprovisioning",
  "stuck",
  "paused",
] as const

export const RUNNER_CLAIM_STATES = [...RUNNER_STATES, "stopped"] as const

export type RunnerClaimState = (typeof RUNNER_CLAIM_STATES)[number]

export type RunnerClaim = Readonly<{
  host: string
  pid: number
  started: string
  at: string
  /** Integer milliseconds, at least 30 seconds; serialized as `Beat: <integer>ms`. */
  beatMs: number
  state: RunnerClaimState
  /** Present only while a change is selected. */
  holding?: string
  since: string
  /** Current phase bound; absent on unbounded states and in legacy claims. */
  deadline?: string
  /** Fixed whole-round plan, published together after the current line is read. */
  due?: string
  round?: string
  candidates?: number
  /** Linux process identity, published together when all three values are readable. */
  boot?: string
  pidNamespace?: string
  startTick?: number
  /** Verbatim append-only trailers written by a newer runner. */
  unknownTrailers?: readonly string[]
}>

export type RunnerClaimJudgment = Readonly<{
  status: "fresh" | "silent" | "unreadable"
  reason: string
}>

export type RunnerDeadlineJudgment = Readonly<{
  status: "within" | "overdue" | "unavailable" | "unbounded" | "unreadable"
  reason: string
}>

export type RunnerDueJudgment = Readonly<{
  status: "within" | "overdue" | "unavailable" | "unbounded" | "unreadable"
  reason: string
}>

const SUBJECT = "yrd runner claim"
const ORDER = [
  "Runner",
  "Started",
  "At",
  "Beat",
  "State",
  "Holding",
  "Since",
  "Deadline",
  "Due",
  "Round",
  "Candidates",
  "Boot",
  "PidNamespace",
  "StartTick",
] as const
const REQUIRED = ["Runner", "Started", "At", "Beat", "State", "Since"] as const
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

function instant(value: string, key: string): number {
  const time = Date.parse(value)
  if (!ISO.test(value) || !Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError(`runner claim ${key} must be a canonical UTC ISO instant; got ${JSON.stringify(value)}`)
  }
  return time
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)
  if (value === undefined) throw new TypeError(`runner claim missing ${key} trailer`)
  return value
}

function candidatesOf(value: string): number {
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TypeError(`runner claim Candidates must be a positive safe integer: ${JSON.stringify(value)}`)
  }
  return Number(value)
}

function startTickOf(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TypeError(`runner claim StartTick must be a nonnegative safe integer: ${JSON.stringify(value)}`)
  }
  return Number(value)
}

function checked(claim: RunnerClaim): RunnerClaim {
  if (
    claim.host.length === 0 ||
    /[\s/:]/u.test(claim.host) ||
    [...claim.host].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new TypeError(`runner claim Runner host is invalid: ${JSON.stringify(claim.host)}`)
  }
  if (!Number.isSafeInteger(claim.pid) || claim.pid <= 0) {
    throw new TypeError(`runner claim Runner pid must be a positive integer: ${String(claim.pid)}`)
  }
  const started = instant(claim.started, "Started")
  const at = instant(claim.at, "At")
  const since = instant(claim.since, "Since")
  if (started > at || since < started || since > at) {
    throw new TypeError("runner claim Started, Since and At must be ordered")
  }
  if (!Number.isSafeInteger(claim.beatMs) || claim.beatMs < 30_000) {
    throw new TypeError(`runner claim Beat must be at least 30000 integer milliseconds: ${String(claim.beatMs)}`)
  }
  if (!(RUNNER_CLAIM_STATES as readonly string[]).includes(claim.state)) {
    throw new TypeError(`runner claim State is invalid: ${JSON.stringify(claim.state)}`)
  }
  if (claim.deadline !== undefined) {
    const deadline = instant(claim.deadline, "Deadline")
    if (deadline < since) throw new TypeError("runner claim Deadline must be at or after Since")
    if (claim.state === "idle" || claim.state === "stuck" || claim.state === "paused" || claim.state === "stopped") {
      throw new TypeError(`runner claim Deadline is invalid for ${claim.state} State`)
    }
  }
  if (claim.due !== undefined || claim.round !== undefined || claim.candidates !== undefined) {
    if (claim.due === undefined || claim.round === undefined || claim.candidates === undefined) {
      throw new TypeError("runner claim Due, Round and Candidates must appear together")
    }
    const round = instant(claim.round, "Round")
    const due = instant(claim.due, "Due")
    if (round < started) throw new TypeError("runner claim Round must be at or after Started")
    if (round > since) throw new TypeError("runner claim Round must be at or before Since")
    if (round >= due) throw new TypeError("runner claim Round must be before Due")
    if (!Number.isSafeInteger(claim.candidates) || claim.candidates < 1) {
      throw new TypeError("runner claim Candidates must be a positive safe integer")
    }
    if (claim.state === "idle" || claim.state === "stuck" || claim.state === "paused" || claim.state === "stopped") {
      throw new TypeError(`runner claim Due is invalid for ${claim.state} State`)
    }
  }
  if (claim.boot !== undefined && (claim.boot.length === 0 || /[\r\n]/u.test(claim.boot))) {
    throw new TypeError("runner claim Boot must be one nonempty line")
  }
  if (claim.pidNamespace !== undefined && (claim.pidNamespace.length === 0 || /[\r\n]/u.test(claim.pidNamespace))) {
    throw new TypeError("runner claim PidNamespace must be one nonempty line")
  }
  if (claim.startTick !== undefined && (!Number.isSafeInteger(claim.startTick) || claim.startTick < 0)) {
    throw new TypeError("runner claim StartTick must be a nonnegative safe integer")
  }
  const unknownKeys = new Set<string>()
  for (const line of claim.unknownTrailers ?? []) {
    const match = /^([A-Za-z]+): (.*)$/u.exec(line)
    const key = match?.[1]
    if (key === undefined || (ORDER as readonly string[]).includes(key)) {
      throw new TypeError(`runner claim invalid future trailer: ${JSON.stringify(line)}`)
    }
    if (unknownKeys.has(key)) throw new TypeError(`runner claim duplicate ${key} trailer`)
    unknownKeys.add(key)
  }
  if (claim.holding !== undefined) {
    const change = parseChangeName(claim.holding)
    if (change === undefined) {
      throw new TypeError(`runner claim Holding must be <branch>@<full sha>: ${JSON.stringify(claim.holding)}`)
    }
    try {
      assertBranch(change.branch)
    } catch {
      throw new TypeError(`runner claim Holding has an invalid branch: ${JSON.stringify(claim.holding)}`)
    }
  }
  return claim
}

/** Full root-commit message; Beat's unit is integer milliseconds. */
export function formatRunnerClaim(input: RunnerClaim): string {
  const claim = checked(input)
  const identityCount = [claim.boot, claim.pidNamespace, claim.startTick].filter((value) => value !== undefined).length
  if (identityCount !== 0 && identityCount !== 3) {
    throw new TypeError("runner claim Boot, PidNamespace and StartTick must be written together")
  }
  if (
    claim.deadline === undefined &&
    (claim.state === "provisioning" ||
      claim.state === "checking" ||
      claim.state === "merging" ||
      claim.state === "deprovisioning")
  ) {
    throw new TypeError(`runner claim Deadline is required for ${claim.state} State`)
  }
  return (
    `${SUBJECT}\n\nRunner: ${claim.host}/${String(claim.pid)}\n` +
    `Started: ${claim.started}\nAt: ${claim.at}\nBeat: ${String(claim.beatMs)}ms\n` +
    `State: ${claim.state}\n` +
    (claim.holding === undefined ? "" : `Holding: ${claim.holding}\n`) +
    `Since: ${claim.since}\n` +
    (claim.deadline === undefined ? "" : `Deadline: ${claim.deadline}\n`) +
    (claim.due === undefined
      ? ""
      : `Due: ${claim.due}\nRound: ${claim.round}\nCandidates: ${String(claim.candidates)}\n`) +
    (claim.boot === undefined
      ? ""
      : `Boot: ${claim.boot}\nPidNamespace: ${claim.pidNamespace}\nStartTick: ${String(claim.startTick)}\n`) +
    (claim.unknownTrailers?.map((line) => `${line}\n`).join("") ?? "")
  )
}

/** Refuse incomplete or ambiguous commit messages instead of inventing health. */
export function parseRunnerClaim(body: string): RunnerClaim {
  // `git show --format=%B` appends its own newline after the commit message.
  // Ignore only terminal blank lines; a blank inside the trailers is malformed.
  const lines = body.replace(/\n+$/u, "").split("\n")
  if (lines[0] === SUBJECT && lines[1] === "") lines.splice(0, 2)
  const values = new Map<string, string>()
  const unknownTrailers: string[] = []
  let last = -1
  let unknownTail = false
  for (const line of lines) {
    const match = /^([A-Za-z]+): (.*)$/u.exec(line)
    if (match === null) throw new TypeError(`runner claim malformed trailer: ${JSON.stringify(line)}`)
    const key = match[1]
    const value = match[2]
    if (key === undefined || value === undefined) {
      throw new TypeError(`runner claim malformed trailer: ${JSON.stringify(line)}`)
    }
    const order = (ORDER as readonly string[]).indexOf(key)
    if (order < 0) {
      if (!REQUIRED.every((requiredKey) => values.has(requiredKey))) {
        throw new TypeError(`runner claim unknown trailer ${key} before all required trailers`)
      }
      if (values.has(key)) throw new TypeError(`runner claim duplicate ${key} trailer`)
      // A newer writer may append trailers after this reader's known tail.
      // Known trailers appearing later would make their order ambiguous.
      unknownTail = true
      values.set(key, value)
      unknownTrailers.push(line)
      continue
    }
    if (unknownTail) throw new TypeError(`runner claim known ${key} trailer after unknown tail`)
    if (values.has(key)) throw new TypeError(`runner claim duplicate ${key} trailer`)
    if (order <= last) throw new TypeError(`runner claim ${key} trailer is out of order`)
    values.set(key, value)
    last = order
  }
  for (const key of REQUIRED) {
    if (!values.has(key)) throw new TypeError(`runner claim missing ${key} trailer`)
  }
  const runner = /^([^/]+)\/([1-9]\d*)$/u.exec(required(values, "Runner"))
  if (runner === null) throw new TypeError(`runner claim Runner must be host/positive-pid`)
  const host = runner[1]
  const pid = runner[2]
  if (host === undefined || pid === undefined) throw new TypeError("runner claim Runner must be host/positive-pid")
  const beat = /^([1-9]\d*)ms$/u.exec(required(values, "Beat"))
  if (beat === null) throw new TypeError("runner claim Beat must be integer milliseconds, e.g. 60000ms")
  const beatValue = beat[1]
  if (beatValue === undefined) throw new TypeError("runner claim Beat must be integer milliseconds, e.g. 60000ms")
  return checked({
    host,
    pid: Number(pid),
    started: required(values, "Started"),
    at: required(values, "At"),
    beatMs: Number(beatValue),
    state: required(values, "State") as RunnerClaimState,
    ...(values.has("Holding") ? { holding: required(values, "Holding") } : {}),
    since: required(values, "Since"),
    ...(values.has("Deadline") ? { deadline: required(values, "Deadline") } : {}),
    ...(values.has("Due") ? { due: required(values, "Due") } : {}),
    ...(values.has("Round") ? { round: required(values, "Round") } : {}),
    ...(values.has("Candidates") ? { candidates: candidatesOf(required(values, "Candidates")) } : {}),
    ...(values.has("Boot") ? { boot: required(values, "Boot") } : {}),
    ...(values.has("PidNamespace") ? { pidNamespace: required(values, "PidNamespace") } : {}),
    ...(values.has("StartTick") ? { startTick: startTickOf(required(values, "StartTick")) } : {}),
    ...(unknownTrailers.length === 0 ? {} : { unknownTrailers }),
  })
}

/** A record is silent strictly after three beats; >30 s future At is unreadable. */
export function judgeRunnerClaim(claim: RunnerClaim, now: Date): RunnerClaimJudgment {
  checked(claim)
  const current = now.getTime()
  if (!Number.isFinite(current)) return { status: "unreadable", reason: "reader clock is invalid" }
  const ageMs = current - Date.parse(claim.at)
  if (ageMs < -30_000) {
    return { status: "unreadable", reason: `clock-skew: runner At is ${String(-ageMs)}ms ahead of the reader clock` }
  }
  if (ageMs > 3 * claim.beatMs) {
    return {
      status: "silent",
      reason: `runner At is ${String(ageMs)}ms old, beyond three ${String(claim.beatMs)}ms beats`,
    }
  }
  return { status: "fresh", reason: `runner At is within three ${String(claim.beatMs)}ms beats` }
}

/** One declared-bound judgment for remote claims and local health documents. */
export function judgeRunnerDeadline(claim: RunnerClaim, now: Date): RunnerDeadlineJudgment {
  checked(claim)
  if (claim.state === "idle" || claim.state === "stuck" || claim.state === "paused" || claim.state === "stopped") {
    return { status: "unbounded", reason: `${claim.state} has no phase deadline` }
  }
  if (claim.deadline === undefined) {
    return { status: "unavailable", reason: "deadline unavailable: writer predates Deadline" }
  }
  const current = now.getTime()
  if (!Number.isFinite(current)) return { status: "unreadable", reason: "reader clock is invalid" }
  const since = Date.parse(claim.since)
  if (current < since - 30_000) {
    return {
      status: "unreadable",
      reason: `clock-skew: phase Since is ${String(since - current)}ms ahead of the reader clock`,
    }
  }
  const deadline = Date.parse(claim.deadline) + 3 * claim.beatMs
  if (current > deadline) {
    return {
      status: "overdue",
      reason: `phase Deadline ${claim.deadline} passed more than three ${String(claim.beatMs)}ms beats ago`,
    }
  }
  return {
    status: "within",
    reason: `phase Deadline ${claim.deadline} is within three ${String(claim.beatMs)}ms beats`,
  }
}

/** The same total-plan verdict for a remote ref and the local health document. */
export function judgeRunnerDue(claim: RunnerClaim, now: Date): RunnerDueJudgment {
  checked(claim)
  if (claim.state === "idle" || claim.state === "stuck" || claim.state === "paused" || claim.state === "stopped") {
    return { status: "unbounded", reason: `${claim.state} has no open round plan` }
  }
  if (claim.due === undefined || claim.round === undefined || claim.candidates === undefined) {
    return {
      status: "unavailable",
      reason: "round Due unavailable: the line plan is not published or the writer predates Due",
    }
  }
  const current = now.getTime()
  if (!Number.isFinite(current)) return { status: "unreadable", reason: "reader clock is invalid" }
  const round = Date.parse(claim.round)
  if (current < round - 30_000) {
    return {
      status: "unreadable",
      reason: `clock-skew: Round is ${String(round - current)}ms ahead of the reader clock`,
    }
  }
  const due = Date.parse(claim.due)
  if (current > due + 3 * claim.beatMs) {
    const minutes = Math.floor((due - round) / 60_000)
    const bound =
      minutes < 60
        ? `${String(minutes)}m`
        : `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, "0")}m`
    return {
      status: "overdue",
      reason: `round past its total declared bound (${bound} for ${String(claim.candidates)} candidates, started ${claim.round})`,
    }
  }
  return { status: "within", reason: `round Due ${claim.due} is within three ${String(claim.beatMs)}ms beats` }
}
