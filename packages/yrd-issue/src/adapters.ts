import type { Process } from "@yrd/process"
import type { ConditionalLogger } from "loggily"
import * as z from "zod"
import {
  ISSUE_LOG_NAMESPACE,
  Issue,
  IssueRefSchema,
  IssueSchema,
  type IssueRef,
  type IssueSource,
} from "./issues.ts"

type SourceOptions = Readonly<{
  process: Pick<Process, "run">
  id?: string
  command?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Sink for the loud notice this adapter owes its operator. Defaults to stderr. */
  warn?: (text: string) => void
  /** Host logger (the ROOT one, as everywhere else in the host wiring). The
   * adapter names itself `yrd:issues:source` so one namespace covers every
   * configured source instead of inventing one per tracker. */
  log?: ConditionalLogger
}>

const IssueFieldsSchema = IssueSchema.omit({ ref: true })
const ISSUE_SOURCE_TIMEOUT_MS = 30_000
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
      const revision = context.node.version ?? context.node.updated_at
      return {
        ref,
        title: context.node.title ?? context.node.content ?? context.node.name,
        ...(body ? { description: body } : {}),
        ...(context.node.data?.url === undefined ? {} : { url: context.node.data.url }),
        ...(context.node.data?.labels === undefined ? {} : { labels: context.node.data.labels }),
        ...(revision === undefined ? {} : { revision: String(revision) }),
      }
    },
  )
}

function createIssueSource(
  options: SourceOptions & { id: string },
  argv: (id: string) => readonly string[],
  project: (value: unknown, ref: IssueRef) => unknown,
): IssueSource {
  const sourceId = IssueRefSchema.shape.source.parse(options.id)
  const log = options.log?.child(ISSUE_LOG_NAMESPACE).child("source")
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
      log?.debug?.("Issue source answered.", {
        source: sourceId,
        issue: ref.id,
        argv: command,
        cwd: options.cwd,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
      })
      // Every refusal below states what was RUN, what came BACK, and what was
      // EXPECTED. A source failure is the operator's first contact with an
      // unfamiliar tracker command; a verdict without its evidence costs them a
      // repro run to learn what Yrd already had in hand.
      if (result.timedOut) {
        throw new Error(
          `yrd: issue source '${sourceId}' timed out after ${ISSUE_SOURCE_TIMEOUT_MS}ms for '${ref.id}'; ` +
            evidence(command, result),
        )
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `yrd: issue source '${sourceId}' exited ${result.exitCode} for '${ref.id}'; ${evidence(command, result)}`,
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout)
      } catch (error) {
        // The command and its actual output ARE the diagnosis. A bare "invalid
        // JSON" hides the usual cause — a log line the source wrote onto the
        // same stdout the protocol owns — and costs an operator a repro run.
        if (!(error instanceof SyntaxError)) throw error
        throw new Error(
          `yrd: issue source '${sourceId}' returned invalid JSON for '${ref.id}'; ` +
            `command: ${command.join(" ")}; stdout: ${outputEvidence(result.stdout)}`,
        )
      }
      try {
        return Issue.parse(project(parsed, ref))
      } catch (error) {
        // Well-formed JSON that is not a well-formed ISSUE. The schema complaint
        // alone names a field, never the command that produced it, so an
        // operator cannot tell a broken source from a genuinely thin issue.
        throw new Error(
          `yrd: issue source '${sourceId}' returned JSON that is not an issue for '${ref.id}': ` +
            `${detail(error)}; command: ${command.join(" ")}; stdout: ${outputEvidence(result.stdout)}`,
        )
      }
    },
  }
}

const OUTPUT_EVIDENCE_LIMIT = 200

function evidence(command: readonly string[], result: Readonly<{ stdout: string; stderr: string }>): string {
  return (
    `command: ${command.join(" ")}; ` +
    `stderr: ${outputEvidence(result.stderr)}; stdout: ${outputEvidence(result.stdout)}`
  )
}

function outputEvidence(output: string): string {
  if (output === "") return "(empty)"
  const head = output.slice(0, OUTPUT_EVIDENCE_LIMIT)
  return JSON.stringify(output.length > OUTPUT_EVIDENCE_LIMIT ? `${head}…` : head)
}

/** A raw ZodError message is a multi-line JSON dump of its issue list, which
 * buries the one field that actually failed. Render the shape complaint the way
 * an operator reads it: `node.title: expected string`. */
function detail(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join(", ")
  }
  return error instanceof Error ? error.message : String(error)
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
