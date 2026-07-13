import { raiseFailure, type CommandTree, type YrdDef } from "@yrd/core"
import * as z from "zod"

const TextSchema = z.string().trim().min(1)

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
export type IssuesOptions = Readonly<{ sources?: readonly IssueSource[]; defaultSource?: string }>

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

  return {
    sources: [...sourceById.keys()],
    ref(input) {
      const separator = input.indexOf(":")
      return separator > 0
        ? Issue.ref(input.slice(0, separator), input.slice(separator + 1))
        : Issue.ref(defaultSource, input)
    },
    async resolve(ref) {
      const canonical = IssueRefSchema.parse(ref)
      const source = sourceById.get(canonical.source)
      if (!source) {
        raiseFailure(
          "configuration",
          "issue-source-missing",
          `yrd: no issue source '${canonical.source}' is registered`,
        )
      }
      const value = await source.resolve(canonical)
      if (!value) {
        raiseFailure("refusal", "issue-not-found", `yrd: issue '${canonical.source}:${canonical.id}' was not found`)
      }
      const issue = Issue.parse(value)
      if (issue.ref.source !== canonical.source || issue.ref.id !== canonical.id) {
        raiseFailure(
          "infrastructure",
          "issue-source-invalid",
          `yrd: issue source '${source.id}' returned the wrong issue`,
        )
      }
      return issue
    },
  }
}

export function withIssues(options: IssuesOptions = {}) {
  const issues = createIssues(options)
  return <State extends object, Commands extends CommandTree, Features extends object>(
    definition: YrdDef<State, Commands, Features>,
  ) => definition.extend({ create: () => ({ issues }) })
}
