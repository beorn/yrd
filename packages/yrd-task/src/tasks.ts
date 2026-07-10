import { raiseFailure, type CommandTree, type YrdDef } from "@yrd/core"
import * as z from "zod"

const TextSchema = z.string().trim().min(1)

export const TaskRefSchema = z.object({ source: TextSchema, id: TextSchema })
export type TaskRef = z.infer<typeof TaskRefSchema>

export const TaskSchema = z.object({
  ref: TaskRefSchema,
  title: TextSchema,
  description: TextSchema.optional(),
  url: TextSchema.optional(),
  labels: z.array(TextSchema).optional(),
  revision: TextSchema.optional(),
})
export type Task = z.infer<typeof TaskSchema>

export type TaskSource = Readonly<{
  id: string
  resolve(ref: TaskRef): Task | undefined | Promise<Task | undefined>
}>
export type Tasks = Readonly<{
  sources: readonly string[]
  ref(input: string): TaskRef
  resolve(ref: TaskRef): Promise<Task>
}>
export type HasTasks = Readonly<{ tasks: Tasks }>
export type TasksOptions = Readonly<{ sources?: readonly TaskSource[]; defaultSource?: string }>

export const Task = Object.freeze({
  ref(source: unknown, id: unknown): TaskRef {
    return TaskRefSchema.parse({ source, id })
  },
  parse(value: unknown): Task {
    return TaskSchema.parse(value)
  },
})

export function createTasks(options: TasksOptions = {}): Tasks {
  const sourceById = new Map<string, TaskSource>()
  for (const source of options.sources ?? []) {
    const id = TaskRefSchema.shape.source.parse(source.id)
    if (sourceById.has(id)) {
      raiseFailure("configuration", "task-source-duplicate", `yrd: duplicate task source '${id}'`)
    }
    sourceById.set(id, source)
  }
  const defaultSource = TaskRefSchema.shape.source.parse(options.defaultSource ?? "km")

  return {
    sources: [...sourceById.keys()],
    ref(input) {
      const separator = input.indexOf(":")
      return separator > 0
        ? Task.ref(input.slice(0, separator), input.slice(separator + 1))
        : Task.ref(defaultSource, input)
    },
    async resolve(ref) {
      const canonical = TaskRefSchema.parse(ref)
      const source = sourceById.get(canonical.source)
      if (!source) {
        raiseFailure("configuration", "task-source-missing", `yrd: no task source '${canonical.source}' is registered`)
      }
      const value = await source.resolve(canonical)
      if (!value) {
        raiseFailure("refusal", "task-not-found", `yrd: task '${canonical.source}:${canonical.id}' was not found`)
      }
      const task = Task.parse(value)
      if (task.ref.source !== canonical.source || task.ref.id !== canonical.id) {
        raiseFailure("infrastructure", "task-source-invalid", `yrd: task source '${source.id}' returned the wrong task`)
      }
      return task
    },
  }
}

export function withTasks(options: TasksOptions = {}) {
  const tasks = createTasks(options)
  return <State extends object, Commands extends CommandTree, Features extends object>(
    definition: YrdDef<State, Commands, Features>,
  ) => definition.extend({ create: () => ({ tasks }) })
}
