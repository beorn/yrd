import type { HasTasks, Task as TaskValue, TaskRef, TaskSource, WithTasksOptions } from "./types.ts"

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`yrd: ${label} must not be empty`)
  return value.trim()
}

function optional(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label)
}

export const Task = Object.freeze({
  ref(source: unknown, id: unknown): TaskRef {
    return { source: text(source, "task source"), id: text(id, "task id") }
  },
  parse(input: unknown): TaskValue {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new Error("yrd: task must be an object")
    const value = input as Record<string, unknown>
    const ref = value.ref as Record<string, unknown> | undefined
    if (typeof ref !== "object" || ref === null) throw new Error("yrd: task ref must be an object")
    const labels = value.labels
    if (
      labels !== undefined &&
      (!Array.isArray(labels) || labels.some((label) => typeof label !== "string" || label.trim() === ""))
    ) {
      throw new Error("yrd: task labels must be non-empty strings")
    }
    return {
      ref: Task.ref(ref.source, ref.id),
      title: text(value.title, "task title"),
      ...(optional(value.description, "task description") === undefined
        ? {}
        : { description: optional(value.description, "task description") }),
      ...(optional(value.url, "task URL") === undefined ? {} : { url: optional(value.url, "task URL") }),
      ...(labels === undefined ? {} : { labels: labels.map((label) => (label as string).trim()) }),
      ...(optional(value.revision, "task revision") === undefined
        ? {}
        : { revision: optional(value.revision, "task revision") }),
    }
  },
})

export function withTasks(options: WithTasksOptions = {}) {
  const sources = new Map<string, TaskSource>()
  for (const source of options.sources ?? []) {
    const id = text(source.id, "task source id")
    if (sources.has(id)) throw new Error(`yrd: duplicate task source '${id}'`)
    sources.set(id, source)
  }
  const defaultSource = text(options.defaultSource ?? "km", "default task source")
  return <App extends object>(app: App): App & HasTasks => {
    const tasks: HasTasks["tasks"] = {
      sources: [...sources.keys()],
      ref(input) {
        const separator = input.indexOf(":")
        return separator > 0
          ? Task.ref(input.slice(0, separator), input.slice(separator + 1))
          : Task.ref(defaultSource, input)
      },
      async resolve(ref) {
        const canonical = Task.ref(ref.source, ref.id)
        const source = sources.get(canonical.source)
        if (source === undefined) throw new Error(`yrd: no task source '${canonical.source}' is registered`)
        const task = await source.resolve(canonical)
        if (task === undefined) throw new Error(`yrd: task '${canonical.source}:${canonical.id}' was not found`)
        const parsed = Task.parse(task)
        if (parsed.ref.source !== canonical.source || parsed.ref.id !== canonical.id) {
          throw new Error(`yrd: task source '${source.id}' returned the wrong task`)
        }
        return parsed
      },
    }
    return Object.assign(app, { tasks })
  }
}
