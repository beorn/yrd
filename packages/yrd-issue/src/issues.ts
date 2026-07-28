import { failureFact, observeYrdLifecycle, raiseFailure, type CommandTree, type YrdDef } from "@yrd/core"
import type { ConditionalLogger } from "loggily"
import * as z from "zod"

const TextSchema = z.string().trim().min(1)

/** The one namespace segment this layer owns. Both the resolver and its command
 * adapters hang off it, so `DEBUG='yrd:issues:*'` is the whole issue story and
 * neither file has to guess what the other named itself. */
export const ISSUE_LOG_NAMESPACE = "issues"

export const IssueRefSchema = z.object({ source: TextSchema, id: TextSchema })
export type IssueRef = z.infer<typeof IssueRefSchema>

export const IssueSchema = z.object({
  ref: IssueRefSchema,
  title: TextSchema,
  description: TextSchema.optional(),
  url: TextSchema.optional(),
  labels: z.array(TextSchema).optional(),
  revision: TextSchema.optional(),
})
export type Issue = z.infer<typeof IssueSchema>

export type IssueSource = Readonly<{
  id: string
  resolve(ref: IssueRef): Issue | undefined | Promise<Issue | undefined>
}>
export type Issues = Readonly<{
  sources: readonly string[]
  ref(input: string): IssueRef
  resolve(ref: IssueRef): Promise<Issue>
}>
export type HasIssues = Readonly<{ issues: Issues }>
export type IssuesOptions = Readonly<{
  sources?: readonly IssueSource[]
  defaultSource?: string
  /** Host logger. Issue resolution is the FIRST phase of `yrd do`, so its
   * boundary belongs in the one-line story of a run — not only in the process
   * rows of whatever subprocess a source happens to spawn. */
  log?: ConditionalLogger
}>

export const Issue = Object.freeze({
  ref(source: unknown, id: unknown): IssueRef {
    return IssueRefSchema.parse({ source, id })
  },
  parse(value: unknown): Issue {
    return IssueSchema.parse(value)
  },
})

export function createIssues(options: IssuesOptions = {}): Issues {
  const sourceById = new Map<string, IssueSource>()
  for (const source of options.sources ?? []) {
    const id = IssueRefSchema.shape.source.parse(source.id)
    if (sourceById.has(id)) {
      raiseFailure("configuration", "issue-source-duplicate", `yrd: duplicate issue source '${id}'`)
    }
    sourceById.set(id, source)
  }
  const defaultSource = IssueRefSchema.shape.source.parse(options.defaultSource ?? "km")
  const log = options.log?.child(ISSUE_LOG_NAMESPACE)

  return {
    sources: [...sourceById.keys()],
    ref(input) {
      const separator = input.indexOf(":")
      return separator > 0
        ? Issue.ref(input.slice(0, separator), input.slice(separator + 1))
        : Issue.ref(defaultSource, input)
    },
    async resolve(ref) {
      if (log === undefined) return resolveIssue(ref)
      return observeYrdLifecycle(
        log,
        {
          lifecycle: "resolve",
          identity: { issue: `${ref.source}:${ref.id}` },
          milestone: true,
          resultAttributes: (issue: Issue) => ({
            title: issue.title,
            ...(issue.revision === undefined ? {} : { revision: issue.revision }),
          }),
        },
        () => resolveIssue(ref),
      )
    },
  }

  async function resolveIssue(ref: IssueRef): Promise<Issue> {
    const canonical = IssueRefSchema.parse(ref)
    const source = sourceById.get(canonical.source)
    if (!source) {
      raiseFailure("configuration", "issue-source-missing", `yrd: no issue source '${canonical.source}' is registered`)
    }
    let value: Issue | undefined
    try {
      value = await source.resolve(canonical)
    } catch (error) {
      if (failureFact(error) !== undefined) throw error
      const detail = (error instanceof Error ? error.message : String(error)).replace(/^yrd:\s*/u, "")
      raiseFailure(
        "infrastructure",
        "issue-source-failed",
        `yrd: cannot resolve issue '${canonical.id}': configured source '${source.id}' failed: ${detail}`,
      )
    }
    if (!value) {
      raiseFailure("refusal", "issue-not-found", `yrd: issue '${canonical.source}:${canonical.id}' was not found`)
    }
    const issue = Issue.parse(value)
    if (issue.ref.source !== canonical.source || issue.ref.id !== canonical.id) {
      raiseFailure("infrastructure", "issue-source-invalid", `yrd: issue source '${source.id}' returned the wrong issue`)
    }
    return issue
  }
}

export function withIssues(options: IssuesOptions = {}) {
  const issues = createIssues(options)
  return <State extends object, Commands extends CommandTree, Features extends object>(
    definition: YrdDef<State, Commands, Features>,
  ) => definition.extend({ create: () => ({ issues }) })
}
