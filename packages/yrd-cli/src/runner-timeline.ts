import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { hyperlink } from "@silvery/ansi"
import type { Event } from "loggily"
import { artifactHref, artifactLabel, artifactLocation } from "./artifact-reference.ts"
import { failureSlug } from "./failure-slug.ts"

/**
 * Pure watch-timeline grammar shared by the interactive queue view and the
 * resident follow-runner's human narration. Lifecycle rows read one state
 * transition per row — `[<base>#<run>/<index>-<step>] starting|finished` —
 * with the bracketed identity itself linking to the owned artifact directory.
 * Keeping these helpers here (not in the queue view .tsx) means the headless
 * logger never imports React or the Silvery reconciler.
 *
 * The resident stream reports EACH step exactly once — success at INFO, failure
 * at ERROR. The enclosing run/compose settlements are redundant roll-ups of what
 * a step row already carried, so they are dropped from the human stream (they
 * stay, full-fidelity, in the JSONL file sink). A run that failed with no step
 * to own the ERROR (a pinned/stale-base refusal rejected before the step's Job
 * ran) escalates to a run-scoped ERROR row, so no failure is ever silent.
 */

/** Powerline branch glyph (U+E0A0), the same BRANCH_ICON the watch UI prefixes
 * onto every branch name (user directive 2026-07-16). */
export const TIMELINE_BRANCH_ICON = ""

/** Distinct queue lifecycle markers from the settled km/ag watch vocabulary. */
export function timelineStatusGlyph(status: string): string {
  if (["checking", "running", "waiting"].includes(status)) return "●"
  if (["integrated", "passed"].includes(status)) return "✓"
  if (["rejected", "failed", "lost", "stale", "legacy", "refused", "environment-refused"].includes(status)) {
    return "×"
  }
  if (["withdrawn", "retired", "canceled"].includes(status)) return "−"
  // Pre-run WIP (draft = clean, revising = a draft with failed-submission history)
  // gets a hollow dotted marker, distinct from the solid `○` a `submitted` row
  // carries. Color separates draft (muted) from revising (warn).
  if (status === "draft" || status === "revising") return "◌"
  return "○"
}

/** Coarse human duration (largest unit): the watch timeline's formatDuration. */
export function formatDuration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds)
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

/** Lifecycle durations preserve subordinate units because a named completion
 * row is durable operator evidence, not a compact watch-table cell. */
function formatLifecycleDuration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds)
  if (ms < 60_000) return formatDuration(ms)
  const totalSeconds = Math.floor(ms / 1_000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return [
    days > 0 ? `${days}d` : "",
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    seconds > 0 ? `${seconds}s` : "",
  ].join("")
}

/** Canonical structured scope for run lifecycle events. Human lifecycle rows
 * omit the repeated scope prefix; their bracketed run/step identity carries the
 * distinction while JSONL keeps each event's complete namespace. */
const RUN_SCOPE = "yrd:queue:run"

/** Session-constant identity bound ONCE at the resident logger scope
 * (runner/host/pane). Elided from every row's JSON tail so a constant never
 * dominates the human stream; the JSONL file sink still records it in full. */
const SESSION_SCOPE_FIELDS = new Set(["runner", "host", "pane"])

const ANSI = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
})

type Paint = (text: string) => string
const paint =
  (color: boolean, code: string): Paint =>
  (text) =>
    color ? `${code}${text}${ANSI.reset}` : text

type PRProps = Readonly<{ pr?: string; revision?: number; branch?: string; issue?: string }>
type OutcomeProps = Readonly<{
  run?: string
  base?: string
  step?: string
  index?: number
  attempt?: number
  status?: string
  outcome?: string
  durationMs?: number
  diagnostic?: string
  completion?: boolean
  continuation?: boolean
  error?: Readonly<{ code?: string; message?: string }>
  failure?: Readonly<{ code?: string; message?: string }>
  artifacts?: readonly unknown[]
  prs?: readonly PRProps[]
}>

type ResidentLogFormatOptions = Readonly<{
  color: boolean
  artifactRoot?: string
  includeDebug?: boolean
}>

function artifactLink(location: Readonly<{ path: string } | { url: string }>, label: string): string {
  return hyperlink(label, artifactHref(location))
}

function recordedArtifact(
  artifacts: readonly unknown[] | undefined,
  event: "done" | "failed",
): Readonly<{ location: Readonly<{ path: string } | { url: string }>; name: string }> | undefined {
  const recorded = (artifacts ?? []).flatMap((artifact) => {
    const location = artifactLocation(artifact)
    if (location === undefined) return []
    const name = artifactLabel(artifact, location)
    return [{ location, name }]
  })
  if (recorded.length === 0) return undefined
  const preferredNames = event === "failed" ? ["stderr", "output", "stdout"] : ["output", "stdout", "stderr"]
  const artifact =
    preferredNames.flatMap((name) => recorded.filter((candidate) => candidate.name === name))[0] ?? recorded[0]
  return artifact
}

function artifactHome(props: OutcomeProps, artifactRoot: string): string | undefined {
  if (props.run === undefined) return undefined
  if (props.step === undefined || props.index === undefined || props.attempt === undefined) {
    return join(artifactRoot, props.run)
  }
  return join(artifactRoot, props.run, `${props.index}-${props.step}`, `attempt-${props.attempt}`)
}

/** Resolve the artifact home a resident event owns. The host creates this
 * before formatting the start row so a printed OSC8 target already exists. */
export function residentArtifactHome(event: Event, artifactRoot: string): string | undefined {
  if (event.kind !== "log") return undefined
  return artifactHome((event.props ?? {}) as OutcomeProps, artifactRoot)
}

function artifactTarget(
  props: OutcomeProps,
  artifactRoot: string | undefined,
  event: "admitted" | "started" | "done" | "failed",
): Readonly<{ path: string } | { url: string }> | undefined {
  if (artifactRoot !== undefined) {
    const home = artifactHome(props, artifactRoot)
    if (home !== undefined && existsSync(home)) return { path: home }
  }
  if (event !== "done" && event !== "failed") return undefined
  const artifact = recordedArtifact(props.artifacts, event)
  if (artifact === undefined) return undefined
  if ("path" in artifact.location && props.step !== undefined) return { path: dirname(artifact.location.path) }
  return artifact.location
}

/** The system-local wall-clock cell shared by queue watch and runner logs. */
export function formatLocalClock(when: Date, includeDate = false): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
  if (!includeDate) return clock
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
  return `${day}T${clock}`
}

/** `HH:MM:SS` from an epoch-ms event time — loggily's own console time cell. */
function eventTime(time: number): string {
  return formatLocalClock(new Date(time))
}

/** The loggily console level word, colored as loggily colors it. */
function levelWord(level: string, color: boolean): string {
  const label = level.toUpperCase()
  if (!color) return label
  if (level === "info") return paint(color, ANSI.blue)(label)
  if (level === "warn") return paint(color, ANSI.yellow)(label)
  if (level === "error") return paint(color, ANSI.red)(label)
  return paint(color, ANSI.dim)(label)
}

/** The loggily-style lead-in: dim time, colored level, cyan scope. */
function prefix(time: number, level: string, scope: string, color: boolean): string {
  return `${paint(color, ANSI.dim)(eventTime(time))} ${levelWord(level, color)} ${paint(color, ANSI.cyan)(scope)}`
}

/** `<base>#<run-number>` — the run identity a human scans, e.g. `main#324` from
 * base `main` and run id `R324`. Falls back to the raw run id when base is
 * absent, and to the raw id when it is not the canonical `R<n>` shape. */
function runRef(props: OutcomeProps): string {
  const run = props.run ?? "?"
  const number = /^R\d+$/u.test(run) ? run.slice(1) : run
  return props.base === undefined ? run : `${props.base}#${number}`
}

/** `<index>-<step>` in artifact-directory order (zero-based), suffixed
 * `#<attempt>` on a retry, e.g. `0-check` or `1-merge#2`. `undefined` for a
 * run-owned row that no single step owns. */
function stepToken(props: OutcomeProps): string | undefined {
  if (props.step === undefined) return undefined
  const numbered = typeof props.index === "number" ? `${props.index}-${props.step}` : props.step
  return props.attempt !== undefined && props.attempt > 1 ? `${numbered}#${props.attempt}` : numbered
}

function prRef(pr: PRProps): string | undefined {
  if (pr.pr === undefined) return undefined
  const number = /^PR\d+$/iu.test(pr.pr) ? pr.pr.slice(2) : pr.pr
  return `pr#${number}.${pr.revision ?? 1}`
}

function admissionTail(props: OutcomeProps, color: boolean): string {
  const prs = props.prs
  if (prs === undefined || prs.length === 0) return ""
  const facts = prs.flatMap((pr) => {
    const ref = prRef(pr)
    if (ref === undefined) return []
    const issue = pr.issue === undefined ? "" : ` issue=${pr.issue}`
    return [`${ref}${issue}`]
  })
  return facts.length === 0 ? "" : ` ${paint(color, ANSI.dim)(facts.join(" "))}`
}

function composedPRTail(props: OutcomeProps, color: boolean): string {
  const refs = (props.prs ?? []).flatMap((pr) => {
    const ref = prRef(pr)
    return ref === undefined ? [] : [ref]
  })
  return refs.length < 2 ? "" : ` ${paint(color, ANSI.dim)(`prs=${refs.join(",")}`)}`
}

function timelineTag(
  props: OutcomeProps,
  color: boolean,
  target?: Readonly<{ path: string } | { url: string }>,
): string {
  const ref = paint(color, ANSI.bold)(runRef(props))
  const token = stepToken(props)
  const label = token === undefined ? `[${ref}]` : `[${ref}/${token}]`
  return target === undefined ? label : artifactLink(target, label)
}

/** The canonical failure slug for `err=<slug>`: the JobError code a failed step
 * carries, else the FailureFact code a thrown refusal/failure carries. */
function errSlug(props: OutcomeProps): string | undefined {
  const code = props.error?.code ?? props.failure?.code
  return code === undefined ? undefined : failureSlug(code)
}

function failureCause(props: OutcomeProps): string | undefined {
  const message = props.error?.message ?? props.failure?.message
  const oneLine = message?.replace(/\s+/gu, " ").trim()
  if (oneLine === undefined || oneLine === "") return undefined
  const limit = 240
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`
}

/** `finished` (INFO/success) or `failed` (ERROR/failure), or `undefined` when the
 * event is not a terminal step/run OUTCOME (e.g. a duration-invalid diagnostic,
 * which carries its own `diagnostic` field and must NOT masquerade as a row). */
function outcomeVerb(props: OutcomeProps, level: string): "finished" | "failed" | undefined {
  if (props.diagnostic !== undefined) return undefined
  if (props.outcome === "succeeded" || props.status === "passed") return "finished"
  if (
    props.outcome === "failed" ||
    props.outcome === "settled" ||
    ["failed", "lost", "stale", "legacy", "refused", "canceled", "rejected", "environment-refused"].includes(
      props.status ?? "",
    )
  ) {
    return "failed"
  }
  if (level === "error") return "failed"
  if (level === "info") return "finished"
  return undefined
}

/** Render one terminal state transition. The bracket tag owns the artifact
 * link; success is green, failure is red, and duration is an explicit field.
 * `undefined` lets the caller render non-lifecycle events as plain notices. */
function renderOutcomeRow(
  props: OutcomeProps,
  level: string,
  color: boolean,
  artifactRoot?: string,
): string | undefined {
  const verb = outcomeVerb(props, level)
  if (verb === undefined) return undefined
  const tag = timelineTag(props, color, artifactTarget(props, artifactRoot, verb === "finished" ? "done" : verb))
  const verbCell = paint(color, verb === "finished" ? ANSI.green : ANSI.red)(verb)
  const prsCell = composedPRTail(props, color)
  const durationCell =
    props.durationMs === undefined
      ? ""
      : ` ${paint(color, ANSI.dim)(`duration=${formatLifecycleDuration(props.durationMs)}`)}`
  const errCell = verb === "failed" && errSlug(props) !== undefined ? ` err=${errSlug(props)}` : ""
  const cause = verb === "failed" ? failureCause(props) : undefined
  const causeCell = cause === undefined ? "" : ` cause=${JSON.stringify(cause)}`
  return `${tag} ${verbCell}${prsCell}${durationCell}${errCell}${causeCell}`
}

function renderStartedRow(props: OutcomeProps, color: boolean, artifactRoot?: string): string | undefined {
  // A durable run can require several settlement attempts. Those attempts stay
  // observable in JSONL, but only the first transition is an admission edge.
  if (
    props.outcome !== "started" ||
    props.run === undefined ||
    props.completion === true ||
    props.continuation === true
  ) {
    return undefined
  }
  const token = stepToken(props)
  const event = token === undefined ? "admitted" : "started"
  const tag = timelineTag(props, color, artifactTarget(props, artifactRoot, event))
  const label = token === undefined ? "admitted" : "starting"
  const verb = paint(color, ANSI.blue)(label)
  return token === undefined
    ? `${tag} ${verb}${admissionTail(props, color)}`
    : `${tag} ${verb}${composedPRTail(props, color)}`
}

/** Generic INFO/WARN/ERROR notice fields as a dimmed JSON tail, minus the
 * session-constant scope identity. Lifecycle narration rows deliberately do
 * not call this: their full structured records live only in JSONL. */
function jsonTail(props: Record<string, unknown>, color: boolean): string {
  const omitted = new Set(["artifacts", "checkpoint", "evidence", "output", "stderr", "stdout"])
  const entries = Object.entries(props).filter(
    ([key, value]) => !SESSION_SCOPE_FIELDS.has(key) && !omitted.has(key) && value !== undefined,
  )
  if (entries.length === 0) return ""
  return ` ${paint(color, ANSI.dim)(JSON.stringify(Object.fromEntries(entries)))}`
}

/**
 * Format one resident-runner log Event as a human line, or `undefined` to
 * suppress it from the human stream (it still reaches the JSONL file sink).
 *
 * - `yrd:jobs:<step>` transitions → bracket-first step narration.
 * - `yrd:queue:run` / `yrd:queue:compose` INFO/DEBUG settlements → suppressed
 *   (redundant roll-ups of step rows), a run-owned ERROR/WARN still surfaces.
 * - `yrd:journal:*` INFO/DEBUG chatter → suppressed.
 * - unrelated DEBUG/TRACE bookkeeping → JSONL only; it never floods narration.
 * - every other INFO/WARN/ERROR event → a loggily-style notice (prefix +
 *   message + JSON tail), so drain, refusals, recovery, and diagnostics stay loud.
 */
export function formatResidentLogLine(event: Event, options: ResidentLogFormatOptions): string | undefined {
  if (event.kind !== "log") return undefined
  const { color } = options
  const namespace = event.namespace
  const level = event.level
  const props = (event.props ?? {}) as OutcomeProps & Record<string, unknown>

  // Low-level journal bookkeeping is noise on the human line — JSONL sink only.
  // Its warn/error escalations still surface below as notices.
  if (namespace.startsWith("yrd:journal:") && (level === "info" || level === "debug")) return undefined

  if (namespace.startsWith("yrd:jobs:") || namespace === RUN_SCOPE) {
    const started = renderStartedRow(props, color, options.artifactRoot)
    if (started !== undefined) return started
  }

  // DEBUG is enabled so lifecycle starts exist, not to dump every Git/process/
  // projection bookkeeping event into the skippable human lane. Full fidelity
  // remains in JSONL. TRACE is likewise never human narration.
  if ((level === "debug" || level === "trace") && options.includeDebug !== true) return undefined

  // The per-run / per-cycle roll-ups a step row already reported. A genuine
  // non-step failure escalates to ERROR (queueRunOutcome) or WARN (a refusal)
  // and falls through to a row/notice below — it is never suppressed here.
  if ((namespace === RUN_SCOPE || namespace === "yrd:queue:compose") && level === "info") {
    return undefined
  }

  // Step completions and run-owned failures render as bracket-first lifecycle
  // narration without repeating their structured namespace.
  if (namespace.startsWith("yrd:jobs:") || namespace === RUN_SCOPE) {
    const row = renderOutcomeRow(props, level, color, options.artifactRoot)
    if (row !== undefined) return row
  }

  // Everything else: runner start/lease, graceful drain, compose refusals,
  // recovery warns, duration diagnostics — a compact notice, never dropped.
  return `${prefix(event.time, level, namespace, color)} ${event.message}${jsonTail(props, color)}`
}
