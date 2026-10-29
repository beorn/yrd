import type { SameIssue } from "@yrd/queue-core"
import { shellQuote } from "git-super/shell-command"
import { ISSUE_DISPLAY_TIMEOUT_MS } from "./issue-resolver.ts"
import { ISSUES_CODES, substituteArgv, type IssuesCode } from "./issues/declaration.ts"
import { readIssuesDeclaration, runIssuesVerb, type IssuesEnvelope } from "./issues/run.ts"

type Resolution = Readonly<
  | { key: string; declaration: IssuesEnvelope["declaration"] }
  | { why: string; ambiguous: boolean; code: IssuesCode | null }
>
type Identity = Readonly<{ key: string } | { why: string }>

export type IssueComparerInput = Readonly<{
  /** The project whose `issues.yml` declares `resolve`. */
  projectRoot: string
  /** Where the provider runs. */
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Where provider stderr and witnessed-fallback provenance pass through. */
  stderr?: (text: string) => void
  timeoutMs?: number
  /** Automatic effects keep the declaration from their delivered merge. */
  declarationCommit?: string
  signal?: AbortSignal
  noProgressTimeoutMs?: number
}>

/**
 * One command's issue comparer. Only byte-equal legacy raws skip the provider. A witnessed raw always asks live
 * identity, and can supply its exact raw's key only when live resolution is unavailable, never ambiguous or
 * different. The per-command map memoizes provider transport only; witness facts stay in the required inputs.
 */
export function issueComparer(input: IssueComparerInput): SameIssue {
  const resolutions = new Map<string, Promise<Resolution>>()
  const reportedFallbacks = new Set<string>()
  const resolveOnce = (raw: string): Promise<Resolution> => {
    let reading = resolutions.get(raw)
    if (reading === undefined) {
      reading = resolveRaw(input, raw)
      resolutions.set(raw, reading)
    }
    return reading
  }
  return async (a, b) => {
    if (a.kind === "raw-only" && b.kind === "raw-only" && a.raw === b.raw) return { same: true }
    const readings: [Resolution, Resolution] = await Promise.all([resolveOnce(a.raw), resolveOnce(b.raw)])
    const resolved: [Identity, Identity] = [readings[0], readings[1]]
    if (a.raw === b.raw && a.kind === "witnessed" && b.kind === "witnessed" && a.key !== b.key) {
      return {
        same: false,
        resolved: true,
        why: `conflicting Issue-Binding witnesses for ${a.raw}: ${a.key} and ${b.key}`,
      }
    }
    const bindings = [a, b] as const
    const provenance: string[] = []
    for (const index of [0, 1] as const) {
      const binding = bindings[index]
      const peer = bindings[index === 0 ? 1 : 0]
      const live = readings[index]
      const witness =
        binding.kind === "witnessed"
          ? binding.key
          : binding.raw === peer.raw && peer.kind === "witnessed"
            ? peer.key
            : undefined
      if ("key" in live) {
        if (witness !== undefined && live.key !== witness) {
          return {
            same: false,
            resolved: true,
            why: `${binding.raw} resolves live to ${live.key}, but its Issue-Binding witnesses ${witness}`,
          }
        }
      } else if (!live.ambiguous && witness !== undefined) {
        resolved[index] = { key: witness }
        provenance.push(`${live.why}; using witnessed key ${witness} for exact raw ${binding.raw}`)
      }
    }
    const [left, right] = resolved
    if ("key" in left && "key" in right) {
      const details = [...new Set(provenance)]
      if (left.key !== right.key) {
        return {
          same: false,
          resolved: true,
          ...(details.length === 0
            ? {}
            : { why: `${a.raw} identifies ${left.key}; ${b.raw} identifies ${right.key}; ${details.join("; ")}` }),
        }
      }
      for (const detail of details) {
        if (!reportedFallbacks.has(detail)) {
          input.stderr?.(`yrd: ${detail}\n`)
          reportedFallbacks.add(detail)
        }
      }
      return { same: true, key: left.key, ...(details.length === 0 ? {} : { why: details.join("; ") }) }
    }
    const why = [...provenance, ...[left, right].flatMap((resolution) => ("why" in resolution ? [resolution.why] : []))]
    let detail = [...new Set(why)].join("; ")
    // A repair target must come from one LIVE resolved key, not an unavailable or ambiguous provider answer.
    const missing =
      !("key" in readings[0]) && !readings[0].ambiguous && "key" in readings[1]
        ? { raw: a.raw, target: readings[1] }
        : !("key" in readings[1]) && !readings[1].ambiguous && "key" in readings[0]
          ? { raw: b.raw, target: readings[0] }
          : undefined
    if (missing !== undefined) {
      const reading = await readIssuesDeclaration({
        projectRoot: input.projectRoot,
        cwd: input.cwd,
        ...(input.env === undefined ? {} : { env: input.env }),
        declarationCommit: missing.target.declaration.commit,
      })
      if (!reading.ok) detail += `; alias repair declaration could not be read: ${reading.message}`
      else if (reading.definition.alias === undefined) {
        detail += '; this project declares no "alias" repair template in issues.yml'
      } else {
        const argv = substituteArgv(reading.definition.alias, { raw: missing.raw, key: missing.target.key })
        detail += `\nAlias repair:\n${argv.map(shellQuote).join(" ")}\n`
      }
    }
    return { same: false, resolved: false, why: detail }
  }
}

/** Appended to a mismatch receipt: what the comparer said beyond the two spellings it names. */
export function samenessDetail(a: string, b: string, judged: Awaited<ReturnType<SameIssue>>): string {
  if (judged.same) return ""
  if (judged.why !== undefined) return `; ${judged.why}`
  return `; ${a} and ${b} resolve to different issues`
}

export async function resolveRaw(input: IssueComparerInput, raw: string): Promise<Resolution> {
  let said = ""
  const outcome = await runIssuesVerb({
    verb: "resolve",
    args: [raw],
    projectRoot: input.projectRoot,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    timeoutMs: input.timeoutMs ?? ISSUE_DISPLAY_TIMEOUT_MS,
    ...(input.declarationCommit === undefined ? {} : { declarationCommit: input.declarationCommit }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.noProgressTimeoutMs === undefined ? {} : { noProgressTimeoutMs: input.noProgressTimeoutMs }),
    stderr: (text) => {
      said += text
      input.stderr?.(text)
    },
  })
  if (!outcome.ok) {
    if (outcome.code === ISSUES_CODES.declarationMissing || outcome.code === ISSUES_CODES.unsupported) {
      return {
        ambiguous: false,
        code: outcome.code,
        why: `${raw} was not checked against an issues store, because ${input.projectRoot} declares none for it: ${outcome.message}`,
      }
    }
    const line = said
      .split(/\r?\n/u)
      .map((text) => text.trim())
      .filter((text) => text !== "")
      .at(-1)
    return {
      ambiguous: false,
      code: outcome.code,
      why: `resolve ${raw}: ${outcome.message}${line === undefined ? "" : `; the provider said: ${line}`} (project ${input.projectRoot})`,
    }
  }
  const keys = (outcome.envelope.result as { keys: readonly string[] }).keys
  const [key] = keys
  if (keys.length !== 1 || key === undefined) {
    return {
      ambiguous: keys.length > 1,
      code: null,
      why: `resolve ${raw} returned ${keys.length} keys (${keys.join(", ")}), not one issue (project ${input.projectRoot})`,
    }
  }
  return { key, declaration: outcome.envelope.declaration }
}
