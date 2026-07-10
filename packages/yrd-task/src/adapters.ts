import type { Process } from "@yrd/process"
import * as z from "zod"
import { Task, TaskRefSchema, TaskSchema, type TaskRef, type TaskSource } from "./tasks.ts"

type SourceOptions = Readonly<{
  process: Pick<Process, "run">
  id?: string
  command?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}>

const TaskFieldsSchema = TaskSchema.omit({ ref: true })
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

export function createCommandTaskSource(
  options: SourceOptions & { id: string; command: readonly string[] },
): TaskSource {
  if (options.command.length === 0) throw new Error("yrd: task source command must not be empty")
  return createTaskSource(
    options,
    (id) => [...options.command, id],
    (value, ref) => ({
      ...TaskFieldsSchema.parse(value),
      ref,
    }),
  )
}

export function createKmTaskSource(options: SourceOptions): TaskSource {
  const id = options.id ?? "km"
  const command = options.command ?? ["km"]
  return createTaskSource(
    { ...options, id },
    (task) => [...command, "show", "--one", "--context", "--json", task],
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

function createTaskSource(
  options: SourceOptions & { id: string },
  argv: (id: string) => readonly string[],
  project: (value: unknown, ref: TaskRef) => unknown,
): TaskSource {
  const sourceId = TaskRefSchema.shape.source.parse(options.id)
  return {
    id: sourceId,
    async resolve(ref) {
      if (ref.source !== sourceId) throw new Error(`yrd: task source '${sourceId}' cannot resolve '${ref.source}'`)
      const result = await options.process.run({
        argv: argv(ref.id),
        cwd: options.cwd,
        env: cleanEnvironment({ ...options.env, YRD_TASK_SOURCE: ref.source, YRD_TASK_ID: ref.id }),
      })
      if (result.exitCode !== 0) {
        throw new Error(
          `yrd: task source '${sourceId}' exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
        )
      }
      try {
        return Task.parse(project(JSON.parse(result.stdout), ref))
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`yrd: task source '${sourceId}' returned invalid JSON for '${ref.id}'`)
        }
        throw error
      }
    },
  }
}

function cleanEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      ([key, value]) =>
        value !== undefined && !key.startsWith("GIT_") && (!key.startsWith("YRD_") || key.startsWith("YRD_TASK_")),
    ),
  )
}
