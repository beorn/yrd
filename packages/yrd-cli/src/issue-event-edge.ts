/**
 * The issue-event edge (hh #38766, @cto e0638180): a change that is submitted records one `submitted` fact on the issue
 * it names, through the issues interface's declared `event` verb — the same call the post-merge step already makes for
 * `merged`.
 *
 * Why a detached child and not the call itself: one provider write against km measured 35 s on this host (a 31.6 k-row
 * ledger's presence lookup), and during km's lane holds it does not answer at all. `yrd submit` is the command seats run
 * all day, so it never waits for that write: it launches the same CLI's `issues event` verb as a detached child whose
 * stdout and stderr land in the queue's own log tree, one file per event named after its replay key. A launch that fails
 * is reported inline by the caller; a launch that succeeds but does not land leaves its evidence in that file, named.
 */
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs"
import { join } from "node:path"
import { normalizedRemote } from "@yrd/queue-core"
import { resolveExecutable } from "@yrd/process"

/** The bound the detached child hands its provider: generous, because the submit never waits for it. */
export const ISSUE_EVENT_EDGE_TIMEOUT_MS = 60_000

/** The change transitions this edge writes. Both replay under a key named after the head they were observed at. */
export type IssueEventEdgeKind = "submitted" | "merged"

/**
 * The replay key, so a re-submit of the same head writes nothing. km keys its replay record by a ref named after the id,
 * one ref segment with no colon (@cto 721b42d7 condition 2), so the id is spelled with dashes.
 */
export function issueEventOperationId(kind: IssueEventEdgeKind, sha: string): string {
  return `yrd-${kind}-${sha}`
}

/** The `source` an edge event carries: the repository as the queue spells it, at the observed 40-hex sha. */
export function issueEventSource(url: string, sha: string): string {
  return `${normalizedRemote(url)}@${sha}`
}

export type IssueEventLaunch = Readonly<{ launched: true; log: string }> | Readonly<{ launched: false; why: string }>

export type IssueEventLaunchInput = Readonly<{
  readonly kind: IssueEventEdgeKind
  /** The issue exactly as Yrd holds it; the provider resolves it. */
  readonly issue: string
  readonly source: string
  readonly text: string
  readonly opId: string
  /** The project whose `issues.yml` declares `event`. */
  readonly projectRoot: string
  readonly cwd: string
  /** Where the queue keeps its log tree; this event's file is `<workdir>/logs/issue-events/<opId>.log`. */
  readonly workdir: string
  readonly env: NodeJS.ProcessEnv
  /** Tests name the argv that re-enters this CLI; production derives it from how this process was started. */
  readonly self?: readonly string[]
  readonly spawn?: (argv: readonly string[], options: Record<string, unknown>) => unknown
}>

/**
 * Start the write and return at once. `launched: false` names why nothing will ever land and is the caller's to report;
 * `launched: true` means the child owns the outcome and writes it, with its own exit status, into `log`.
 */
export function launchIssueEvent(input: IssueEventLaunchInput): IssueEventLaunch {
  const logDir = join(input.workdir, "logs", "issue-events")
  const log = join(logDir, `${input.opId}.log`)
  let descriptor: number
  try {
    mkdirSync(logDir, { recursive: true })
    descriptor = openSync(log, "a")
    // The header is the launch's own evidence: a file that ends here was started and never finished.
    writeSync(
      descriptor,
      `# yrd issues event ${input.kind} ${input.issue} ${input.opId} launched ${new Date().toISOString()}\n`,
    )
  } catch (error) {
    return { launched: false, why: `the log ${log} could not be opened: ${messageOf(error)}` }
  }
  const argv = [
    ...selfInvocation(input.self),
    "issues",
    "event",
    input.issue,
    input.kind,
    input.source,
    input.text,
    "--id",
    input.opId,
    "--project-root",
    input.projectRoot,
    "--timeout-ms",
    String(ISSUE_EVENT_EDGE_TIMEOUT_MS),
  ]
  const env = definedEnv(input.env)
  const spawn =
    input.spawn ??
    ((command: readonly string[], options: Record<string, unknown>) => Bun.spawn([...command], options as never))
  try {
    const executable = resolveExecutable(argv[0] ?? "", env)
    spawn([executable, ...argv.slice(1)], { cwd: input.cwd, env, stdio: ["ignore", descriptor, descriptor] })
  } catch (error) {
    closeSync(descriptor)
    return { launched: false, why: `the write could not be started: ${messageOf(error)}` }
  }
  // The child holds its own copy of the descriptor; this process's copy closes now.
  closeSync(descriptor)
  return { launched: true, log }
}

/** How this CLI was started, rebuilt as argv that re-enters it: a runtime script keeps its program name, a binary is one. */
function selfInvocation(named: readonly string[] | undefined): string[] {
  if (named !== undefined) return [...named]
  const [executable, script] = process.argv
  if (executable === undefined) throw new Error("issue event edge: this process has no executable to re-enter")
  return script !== undefined && /\.[cm]?[jt]s$/u.test(script) ? [executable, script, "yrd"] : [executable]
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
