import { existsSync } from "node:fs"
import { basename, join } from "node:path"
import { hyperlink } from "@silvery/ansi"
import type { Event } from "loggily"
import { artifactHref, artifactLabel, artifactLocation } from "./artifact-reference.ts"
import { failureSlug } from "./failure-slug.ts"

/**
 * Pure watch-timeline grammar shared by the interactive queue view and the
 * resident follow-runner's human log rows. Its INFO/ERROR rows read one event
 * per row — a scannable `[<base>#<run> <index>:<step>] done|failed <duration>`
 * summary with a canonical @silvery/ansi hyperlink to the full artifact.
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
  if (["rejected", "failed", "lost", "environment-refused"].includes(status)) return "×"
  if (["withdrawn", "retired", "canceled"].includes(status)) return "−"
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

/** Displayed scope for the step/run timeline rows. The events originate at
 * `yrd:jobs:<step>` (per-step Jobs) and `yrd:queue:run` (run-owned failures);
 * the human stream presents them under ONE static run scope so the numbered
 * `<index>:<step>` prefix carries the per-step distinction WITHOUT polluting the
 * namespace taxonomy with unbounded per-run child scopes (user ruling
 * 2026-07-16). The JSONL sink keeps each event's real namespace. */
const RUN_SCOPE = "yrd:queue:run"

/**
 * Where the `<index>:<step>` token sits on a step row. `"bracket"` (Option A,
 * the default) keeps it inside the identity bracket — `[main#324 2:merge]` —
 * which scans best; `"trailing"` (Option B) lifts it to a `step=` field after
 * the verb — `[main#324] failed step=2:merge`. Switching layouts is this one
 * constant; both share the same pure {@link renderOutcomeRow}. */
const STEP_LAYOUT: "bracket" | "trailing" = "bracket"

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

type PRProps = Readonly<{ pr?: string; revision?: number; branch?: string }>
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
): Readonly<{ location: Readonly<{ path: string } | { url: string }>; label: string }> | undefined {
  const recorded = (artifacts ?? []).flatMap((artifact) => {
    const location = artifactLocation(artifact)
    if (location === undefined) return []
    const name = artifactLabel(artifact, location)
    const label = "path" in location ? basename(location.path) || name : name
    return [{ location, label, name }]
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

function artifactPointer(
  props: OutcomeProps,
  artifactRoot: string | undefined,
  event: "admitted" | "started" | "done" | "failed",
): string {
  if (event === "done" || event === "failed") {
    const artifact = recordedArtifact(props.artifacts, event)
    if (artifact !== undefined) return ` log=${artifactLink(artifact.location, artifact.label)}`
  }
  if (artifactRoot === undefined) return ""
  const home = artifactHome(props, artifactRoot)
  if (home === undefined || !existsSync(home)) return ""
  const label = props.step === undefined ? "artifacts" : "logs"
  return ` log=${artifactLink({ path: home }, label)}`
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

/** `<index>:<step>` in execution order (1-based), suffixed `#<attempt>` on a
 * retry (attempt > 1), e.g. `1:check` or `2:merge#2`. `undefined` for a
 * run-owned row that no single step owns. */
function stepToken(props: OutcomeProps): string | undefined {
  if (props.step === undefined) return undefined
  const numbered = typeof props.index === "number" ? `${props.index + 1}:${props.step}` : props.step
  return props.attempt !== undefined && props.attempt > 1 ? `${numbered}#${props.attempt}` : numbered
}

/** Dimmed batch identity so multi-PR runs stay identifiable — especially on a
 * failure. One PR shows `PR.rev branch`; a batch lists refs (capped `+N`). */
function prTail(props: OutcomeProps, color: boolean): string {
  const prs = props.prs
  if (prs === undefined || prs.length === 0) return ""
  const refs = prs.filter((pr) => pr.pr !== undefined).map((pr) => `${pr.pr}.${pr.revision ?? 1}`)
  if (refs.length === 0) return ""
  const CAP = 4
  const shown = refs.slice(0, CAP).join(" ")
  const overflow = refs.length > CAP ? ` +${refs.length - CAP}` : ""
  const branch = refs.length === 1 && prs[0]?.branch !== undefined ? ` ${prs[0].branch}` : ""
  return ` ${paint(color, ANSI.dim)(`· ${shown}${branch}${overflow}`)}`
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

/** `done` (INFO/success) or `failed` (ERROR/failure), or `undefined` when the
 * event is not a terminal step/run OUTCOME (e.g. a duration-invalid diagnostic,
 * which carries its own `diagnostic` field and must NOT masquerade as a row). */
function outcomeVerb(props: OutcomeProps, level: string): "done" | "failed" | undefined {
  if (props.diagnostic !== undefined) return undefined
  if (props.outcome === "succeeded" || props.status === "passed") return "done"
  if (
    props.outcome === "failed" ||
    props.outcome === "settled" ||
    ["failed", "lost", "canceled", "rejected", "environment-refused"].includes(props.status ?? "")
  ) {
    return "failed"
  }
  if (level === "error") return "failed"
  if (level === "info") return "done"
  return undefined
}

/** Render one step/run outcome as the scannable grammar, Option A or B. Bolds
 * the run ref, greens `done` / reds `failed`, dims the duration; appends
 * `err=<slug>` on a failure and the dimmed PR tail. `undefined` when the event
 * is not a terminal outcome (the caller then renders a plain notice). */
function renderOutcomeRow(
  props: OutcomeProps,
  level: string,
  color: boolean,
  artifactRoot?: string,
): string | undefined {
  const verb = outcomeVerb(props, level)
  if (verb === undefined) return undefined
  const ref = paint(color, ANSI.bold)(runRef(props))
  const token = stepToken(props)
  const verbCell = paint(color, verb === "done" ? ANSI.green : ANSI.red)(verb)
  const durationCell =
    props.durationMs === undefined ? "" : ` ${paint(color, ANSI.dim)(formatDuration(props.durationMs))}`
  const errCell = verb === "failed" && errSlug(props) !== undefined ? ` err=${errSlug(props)}` : ""
  const cause = verb === "failed" ? failureCause(props) : undefined
  const causeCell = cause === undefined ? "" : ` cause=${JSON.stringify(cause)}`
  const head =
    STEP_LAYOUT === "bracket" && token !== undefined
      ? `[${ref} ${token}] ${verbCell}`
      : STEP_LAYOUT === "trailing" && token !== undefined
        ? `[${ref}] ${verbCell} step=${token}`
        : `[${ref}] ${verbCell}`
  return `${head}${durationCell}${errCell}${causeCell}${artifactPointer(props, artifactRoot, verb)}${prTail(props, color)}`
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
  const ref = paint(color, ANSI.bold)(runRef(props))
  const token = stepToken(props)
  const event = token === undefined ? "admitted" : "started"
  const verb = paint(color, ANSI.blue)(event)
  const head = token === undefined ? `[${ref}] ${verb}` : `[${ref} ${token}] ${verb}`
  return `${head}${artifactPointer(props, artifactRoot, event)}${prTail(props, color)}`
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
 * Format one resident-runner log Event as a human row, or `undefined` to
 * suppress it from the human stream (it still reaches the JSONL file sink).
 *
 * - `yrd:jobs:<step>` completions → the scannable step row under the run scope.
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

  // Low-level journal bookkeeping is noise on the human row — JSONL sink only.
  // Its warn/error escalations still surface below as notices.
  if (namespace.startsWith("yrd:journal:") && (level === "info" || level === "debug")) return undefined

  if (namespace.startsWith("yrd:jobs:") || namespace === RUN_SCOPE) {
    const started = renderStartedRow(props, color, options.artifactRoot)
    if (started !== undefined) return `${prefix(event.time, level, RUN_SCOPE, color)} ${started}`
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

  // Step completions and run-owned failures render as the one-row-per-step
  // grammar, presented under the single run scope.
  if (namespace.startsWith("yrd:jobs:") || namespace === RUN_SCOPE) {
    const row = renderOutcomeRow(props, level, color, options.artifactRoot)
    if (row !== undefined) return `${prefix(event.time, level, RUN_SCOPE, color)} ${row}`
  }

  // Everything else: runner start/lease, graceful drain, compose refusals,
  // recovery warns, duration diagnostics — a compact notice, never dropped.
  return `${prefix(event.time, level, namespace, color)} ${event.message}${jsonTail(props, color)}`
}
