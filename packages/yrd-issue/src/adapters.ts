import { raiseFailure } from "@yrd/core"
import type { Process } from "@yrd/process"
import * as z from "zod"
import { Issue, IssueRefSchema, IssueSchema, type IssueRef, type IssueSource } from "./issues.ts"

type SourceOptions = Readonly<{
  process: Pick<Process, "run">
  id?: string
  command?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Sink for the loud notice this adapter owes its operator. Defaults to stderr. */
  warn?: (text: string) => void
}>

const IssueFieldsSchema = IssueSchema.omit({ ref: true })
/**
 * Measured 2026-08-30 against this fleet's only configured issue source
 * (`createKmIssueSource`, `km show --one --context --json <id>`, run against
 * the live `/hh/pm` vault — @i/10-yrd/tracker-timeout-is-not-source-unavailable):
 * N=22 real reads (12 sequential + 10 fired concurrently, to probe shared-vault
 * contention) — min 1286ms, median 1487ms, p90 1842ms, max 1854ms. Every
 * observed read, including under self-induced 10-way contention, finished
 * under 2s.
 *
 * That baseline cannot be reconciled with this bead's own motivating incident
 * — a legitimate (non-hung) `yrd issue` read that took 28,344ms in production
 * — because this sandbox has no way to safely reproduce fleet-wide fan-out
 * contention (many concurrent agents across many bays) against the shared
 * vault without risking the vault other agents were actively using. That one
 * historical sample is real measured evidence, not a guess, and it is the
 * only data point available for the tail this bound has to survive.
 * `@cto`'s own ruling on that incident characterized the prior 20_000ms bound
 * as "roughly 3x too tight" — so the bound below is that ruling applied
 * literally (3 x 20_000ms), which also clears the one documented worst-case
 * read (28,344ms) with ~2.1x margin, while staying more than 30x above every
 * latency this fleet's configured source produced under measurement.
 */
const ISSUE_SOURCE_TIMEOUT_MS = 60_000
const KmContextSchema = z.object({
  node: z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    name: z.string().optional(),
    version: z.union([z.string(), z.number()]).optional(),
    updated_at: z.union([z.string(), z.number()]).optional(),
    data: z.object({ url: z.string().optional(), labels: z.array(z.string()).optional() }).optional(),
  }),
  blocks: z.array(z.object({ body: z.array(z.string()).optional() })).optional(),
})

export function createCommandIssueSource(
  options: SourceOptions & { id: string; command: readonly string[] },
): IssueSource {
  if (options.command.length === 0) throw new Error("yrd: issue source command must not be empty")
  return createIssueSource(
    options,
    (id) => [...options.command, id],
    (value, ref) => ({
      ...IssueFieldsSchema.parse(value),
      ref,
    }),
  )
}

export function createKmIssueSource(options: SourceOptions): IssueSource {
  const id = options.id ?? "km"
  const command = options.command ?? ["km"]
  return createIssueSource(
    { ...options, id },
    (issue) => [...command, "show", "--one", "--context", "--json", issue],
    (value, ref) => {
      const context = KmContextSchema.parse(value)
      const body = context.blocks?.at(-1)?.body?.join("\n").trim()
      const revision = present(context.node.version) ?? present(context.node.updated_at)
      const url = present(context.node.data?.url)
      return {
        ref,
        title: present(context.node.title) ?? present(context.node.content) ?? present(context.node.name),
        ...(body ? { description: body } : {}),
        ...(url === undefined ? {} : { url }),
        ...(context.node.data?.labels === undefined ? {} : { labels: context.node.data.labels }),
        ...(revision === undefined ? {} : { revision }),
      }
    },
  )
}

/**
 * Read a km field the way `Issue` reads it: every text field on that schema is
 * trimmed and refuses to be blank, so a blank field is a field the node does
 * not have. `??` alone disagrees — it steps over null/undefined only, so the
 * `version: ""` a km node carries before its first reconcile pass survived to
 * the schema, which then refused the whole issue and left yrd unable to open
 * work on a legitimate bead. The fallbacks each `??` chain already names exist
 * for exactly that node; this makes them fire.
 *
 * Blankness, not falsiness, is the test: `0` is a revision, and a truthiness
 * check would report the node one it does not have instead of the one it does.
 */
function present(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = String(value).trim()
  return text === "" ? undefined : text
}

function createIssueSource(
  options: SourceOptions & { id: string },
  argv: (id: string) => readonly string[],
  project: (value: unknown, ref: IssueRef) => unknown,
): IssueSource {
  const sourceId = IssueRefSchema.shape.source.parse(options.id)
  return {
    id: sourceId,
    async resolve(ref) {
      if (ref.source !== sourceId) throw new Error(`yrd: issue source '${sourceId}' cannot resolve '${ref.source}'`)
      const command = argv(ref.id)
      const result = await options.process.run({
        argv: command,
        cwd: options.cwd,
        env: cleanEnvironment(
          { ...options.env, YRD_ISSUE_SOURCE: ref.source, YRD_ISSUE_ID: ref.id },
          sourceId,
          options.warn === undefined ? {} : { warn: options.warn },
        ),
        timeoutMs: ISSUE_SOURCE_TIMEOUT_MS,
      })
      if (result.timedOut) {
        // A distinct code from the generic 'issue-source-failed'
        // infrastructure catch-all — so a caller (human or `--json` reader)
        // can tell a slow-but-otherwise-live source from a genuinely dead one
        // without parsing this message's free text. `raiseFailure` throws a
        // YrdFailure; issues.ts's resolve() rethrows any error that already
        // carries a failure fact unchanged instead of collapsing it into
        // 'issue-source-failed', so this code and message survive to the CLI
        // intact. Like its 'issue-source-*' siblings, this is a CLI-
        // invocation-time-only code (issues.resolve() is never called from
        // inside the queue's Run/Job engine — see run.ts's three call sites),
        // so it is deliberately not registered in YRD_REFUSAL_CODES, which
        // that closed vocabulary's own header comment excludes by design.
        raiseFailure(
          "infrastructure",
          "issue-source-timeout",
          `yrd: issue source '${sourceId}' timed out after ${result.durationMs}ms; bound ${ISSUE_SOURCE_TIMEOUT_MS}ms`,
        )
      }
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() || result.stdout.trim() || `command exited ${result.exitCode} without output`,
        )
      }
      try {
        return Issue.parse(project(JSON.parse(result.stdout), ref))
      } catch (error) {
        if (error instanceof SyntaxError) {
          // The command and its actual output ARE the diagnosis. A bare "invalid
          // JSON" hides the usual cause — a log line the source wrote onto the
          // same stdout the protocol owns — and costs an operator a repro run.
          throw new Error(
            `yrd: issue source '${sourceId}' returned invalid JSON for '${ref.id}'; ` +
              `command: ${command.join(" ")}; stdout: ${stdoutEvidence(result.stdout)}`,
          )
        }
        throw error
      }
    },
  }
}

const STDOUT_EVIDENCE_LIMIT = 200

function stdoutEvidence(stdout: string): string {
  if (stdout === "") return "(empty)"
  const head = stdout.slice(0, STDOUT_EVIDENCE_LIMIT)
  return JSON.stringify(stdout.length > STDOUT_EVIDENCE_LIMIT ? `${head}…` : head)
}

function defaultWarn(text: string): void {
  process.stderr.write(`${text}\n`)
}

/**
 * Project the ambient environment onto an issue-source subprocess.
 *
 * `stdout` is the protocol channel: the source answers in JSON there and
 * nowhere else. `DEBUG` makes debug-style loggers (km's among them) write their
 * stream to that same channel, which corrupts every response. Drop it — but say
 * so, because a silently dropped variable is an operator asking why their debug
 * run shows nothing. `DEBUG_LOG` is the file rail and stays: it is exactly the
 * escape hatch this refusal points at.
 */
function cleanEnvironment(
  overrides: NodeJS.ProcessEnv | undefined,
  sourceId: string,
  options: Readonly<{ warn?: (text: string) => void }> = {},
): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...overrides }
  if (merged.DEBUG !== undefined) {
    ;(options.warn ?? defaultWarn)(
      `yrd: dropped DEBUG=${merged.DEBUG} from the '${sourceId}' issue-source subprocess — ` +
        "debug output on stdout corrupts the JSON protocol; use DEBUG_LOG=<file> to capture it instead",
    )
  }
  return Object.fromEntries(
    Object.entries(merged).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== "DEBUG" &&
        !key.startsWith("GIT_") &&
        (!key.startsWith("YRD_") || key.startsWith("YRD_ISSUE_")),
    ),
  )
}
