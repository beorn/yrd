import type { SameIssue } from "@yrd/queue-core"
import { ISSUE_DISPLAY_TIMEOUT_MS } from "./issue-resolver.ts"
import { ISSUES_CODES } from "./issues/declaration.ts"
import { runIssuesVerb } from "./issues/run.ts"

type Resolution = Readonly<{ key: string } | { why: string }>

export type IssueComparerInput = Readonly<{
  /** The project whose `issues.yml` declares `resolve`. */
  projectRoot: string
  /** Where the provider runs. */
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Where the provider's stderr passes through. */
  stderr?: (text: string) => void
  timeoutMs?: number
}>

/**
 * One command's issue comparer (31060). Byte-equal keys are one issue with no provider call. Differing keys ask
 * the project's declared `resolve` verb once per distinct raw key, memoized for this invocation only. Two keys
 * are one issue only when each resolves to exactly one key and those keys are equal. Any other outcome is no
 * answer: the caller compares exactly and names what resolve returned. A raw key stays opaque: `/` is not issue
 * structure. When the provider says that raw is missing from saved state, the comparer asks once more for the
 * text after the last `/`, as its own opaque raw key, through this same memo. It names that one key, or the
 * lookup's own failure. That ask never makes the two spellings one issue.
 */
export function issueComparer(input: IssueComparerInput): SameIssue {
  const resolutions = new Map<string, Promise<Resolution>>()
  function resolveOnce(raw: string): Promise<Resolution> {
    const existing = resolutions.get(raw)
    if (existing !== undefined) return existing
    const reading = resolveRaw(input, raw, resolveOnce)
    resolutions.set(raw, reading)
    return reading
  }
  return async (a, b) => {
    if (a === b) return { same: true }
    const [left, right] = await Promise.all([resolveOnce(a), resolveOnce(b)])
    if ("key" in left && "key" in right) {
      return left.key === right.key ? { same: true } : { same: false, resolved: true }
    }
    const why = [left, right].flatMap((resolution) => ("why" in resolution ? [resolution.why] : []))
    return { same: false, resolved: false, why: why.join("; ") }
  }
}

/** Appended to a mismatch receipt: what the comparer said beyond the two spellings it names. */
export function samenessDetail(a: string, b: string, judged: Awaited<ReturnType<SameIssue>>): string {
  if (judged.same) return ""
  return judged.resolved ? `; ${a} and ${b} resolve to different issues` : `; ${judged.why}`
}

async function resolveRaw(
  input: IssueComparerInput,
  raw: string,
  resolveOnce: (raw: string) => Promise<Resolution>,
): Promise<Resolution> {
  let said = ""
  const outcome = await runIssuesVerb({
    verb: "resolve",
    args: [raw],
    projectRoot: input.projectRoot,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    timeoutMs: input.timeoutMs ?? ISSUE_DISPLAY_TIMEOUT_MS,
    stderr: (text) => {
      said += text
      input.stderr?.(text)
    },
  })
  if (!outcome.ok) {
    if (outcome.code === ISSUES_CODES.declarationMissing || outcome.code === ISSUES_CODES.unsupported) {
      return {
        why: `${raw} was not checked against an issues store, because ${input.projectRoot} declares none for it: ${outcome.message}`,
      }
    }
    const line = said
      .split(/\r?\n/u)
      .map((text) => text.trim())
      .filter((text) => text !== "")
      .at(-1)
    if (
      outcome.code === ISSUES_CODES.providerFailed &&
      line !== undefined &&
      line.includes("issue not found in saved state")
    ) {
      const leaf = raw
        .split("/")
        .filter((part) => part !== "")
        .at(-1)
      const found = leaf !== undefined && leaf !== raw ? await resolveOnce(leaf) : undefined
      const hint = found === undefined ? "" : "key" in found ? `; the current issue is ${found.key}` : `; ${found.why}`
      return { why: `${raw} no longer resolves${hint}; the provider said: ${line}` }
    }
    return { why: `resolve ${raw}: ${outcome.message}${line === undefined ? "" : `; the provider said: ${line}`}` }
  }
  const keys = (outcome.envelope.result as { keys: readonly string[] }).keys
  const [key] = keys
  if (keys.length !== 1 || key === undefined) {
    return { why: `resolve ${raw} returned ${keys.length} keys (${keys.join(", ")}), not one issue` }
  }
  return { key }
}
