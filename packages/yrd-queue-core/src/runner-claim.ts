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
}>

export type RunnerClaimJudgment = Readonly<{
  status: "fresh" | "silent" | "unreadable"
  reason: string
}>

const SUBJECT = "yrd runner claim"
const ORDER = ["Runner", "Started", "At", "Beat", "State", "Holding", "Since"] as const
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
  return (
    `${SUBJECT}\n\nRunner: ${claim.host}/${String(claim.pid)}\n` +
    `Started: ${claim.started}\nAt: ${claim.at}\nBeat: ${String(claim.beatMs)}ms\n` +
    `State: ${claim.state}\n` +
    (claim.holding === undefined ? "" : `Holding: ${claim.holding}\n`) +
    `Since: ${claim.since}\n`
  )
}

/** Refuse incomplete or ambiguous commit messages instead of inventing health. */
export function parseRunnerClaim(body: string): RunnerClaim {
  // `git show --format=%B` appends its own newline after the commit message.
  // Ignore only terminal blank lines; a blank inside the trailers is malformed.
  const lines = body.replace(/\n+$/u, "").split("\n")
  if (lines[0] === SUBJECT && lines[1] === "") lines.splice(0, 2)
  const values = new Map<string, string>()
  let last = -1
  for (const line of lines) {
    const match = /^([A-Za-z]+): (.*)$/u.exec(line)
    if (match === null) throw new TypeError(`runner claim malformed trailer: ${JSON.stringify(line)}`)
    const key = match[1]
    const value = match[2]
    if (key === undefined || value === undefined)
      throw new TypeError(`runner claim malformed trailer: ${JSON.stringify(line)}`)
    const order = (ORDER as readonly string[]).indexOf(key)
    if (order < 0) throw new TypeError(`runner claim unknown trailer ${key}`)
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
