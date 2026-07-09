import { event, op, type AnyYrdApp, type DeepReadonly, type ExtendYrdApp, type YrdEvent } from "@yrd/core"
import type {
  Task as TaskRecord,
  TaskCommands,
  TaskIntake,
  TaskRef,
  TasksState,
  TaskSource,
  WithTasksOptions,
} from "./types.ts"

/** Domain operations for canonical task values. */
export const Task = Object.freeze({
  ref(source: string, id: string): TaskRef {
    return parseTaskRef({ source, id })
  },
  sameRef(left: TaskRef, right: TaskRef): boolean {
    return left.source === right.source && left.id === right.id
  },
})

type TasksApp<App extends AnyYrdApp> = ExtendYrdApp<App, { tasks: TasksState }, TaskCommands> & {
  tasks: TaskIntake
}

/** Install tracker-agnostic task intake. Source I/O finishes before the typed
 * `task.record` operation enters Yrd's single-writer event path. */
export function withTasks(options: WithTasksOptions = {}) {
  return <App extends AnyYrdApp>(app: App): TasksApp<App> => {
    Object.assign(app.initialState, { tasks: { bySource: {} } satisfies TasksState })

    const record = op(
      (state: DeepReadonly<{ tasks: TasksState }>, task: TaskRecord) => {
        const current = taskAt(state.tasks, task.ref)
        return {
          events: current !== undefined && sameTask(current, task) ? [] : [event("task/recorded", { task })],
          effects: [],
        }
      },
      {
        title: "Record task",
        description: "Record canonical task context resolved by an adapter or direct API caller",
        args: { parse: parseTask },
      },
    )
    Object.assign(app.commands, { task: { record } })

    const project = app.project
    app.project = (state, applied) => {
      const projected = project(state, applied)
      return applied.name === "task/recorded" ? projectTask(projected as Record<string, unknown>, applied) : projected
    }

    const sources = new Map<string, TaskSource>()
    const intake: TaskIntake = {
      register(source) {
        const id = parseNonEmptyString(source?.id, "task source 'id'")
        if (typeof source.resolve !== "function") throw new Error(`yrd: task source '${id}' must provide resolve()`)
        if (sources.has(id)) throw new Error(`yrd: task source '${id}' is already registered`)
        sources.set(id, source)
      },
      async record(input) {
        const task = parseTask(input)
        await app.command(record, task)
        return (await intake.get(task.ref))!
      },
      async intake(input) {
        const ref = parseTaskRef(input)
        const source = sources.get(ref.source)
        if (source === undefined) throw new Error(`yrd: no task source '${ref.source}' is registered`)
        const resolved = await source.resolve(ref)
        if (resolved === undefined) throw new Error(`yrd: task '${formatRef(ref)}' was not found`)
        const task = parseTask(resolved)
        if (!Task.sameRef(ref, task.ref)) {
          throw new Error(`yrd: task source '${source.id}' returned '${formatRef(task.ref)}' for '${formatRef(ref)}'`)
        }
        return await intake.record(task)
      },
      async get(input) {
        const ref = parseTaskRef(input)
        return taskAt((await app.state()).tasks, ref)
      },
      async list() {
        const { bySource } = (await app.state()).tasks
        return Object.keys(bySource)
          .sort()
          .flatMap((source) =>
            Object.keys(bySource[source]!)
              .sort()
              .map((id) => bySource[source]![id]!),
          )
      },
    }
    for (const source of options.sources ?? []) intake.register(source)
    Object.assign(app, { tasks: intake })

    return app as unknown as TasksApp<App>
  }
}

const TASK_KEYS = new Set(["ref", "title", "description", "url", "labels", "revision"])
const REF_KEYS = new Set(["source", "id"])

function parseTask(input: unknown): TaskRecord {
  const value = plainObject(input, "task")
  rejectUnknownKeys(value, TASK_KEYS, "task")
  const ref = parseTaskRef(value.ref)
  const title = parseNonEmptyString(value.title, "task 'title'")
  const description = optionalString(value.description, "task 'description'")
  const url = optionalString(value.url, "task 'url'")
  const revision = optionalString(value.revision, "task 'revision'")
  const labels = parseLabels(value.labels)
  return {
    ref,
    title,
    ...(description === undefined ? {} : { description }),
    ...(url === undefined ? {} : { url }),
    ...(labels === undefined ? {} : { labels }),
    ...(revision === undefined ? {} : { revision }),
  }
}

function parseTaskRef(input: unknown): TaskRef {
  const value = plainObject(input, "task ref")
  rejectUnknownKeys(value, REF_KEYS, "task ref")
  return {
    source: parseNonEmptyString(value.source, "task ref 'source'"),
    id: parseNonEmptyString(value.id, "task ref 'id'"),
  }
}

function projectTask(state: Record<string, unknown>, applied: YrdEvent): Record<string, unknown> {
  const data = plainObject(applied.data, "task/recorded event data")
  const task = parseTask(data.task)
  const tasks = (state as { tasks: TasksState }).tasks
  const source = own(tasks.bySource, task.ref.source) ?? {}
  return {
    ...state,
    tasks: {
      bySource: {
        ...tasks.bySource,
        [task.ref.source]: { ...source, [task.ref.id]: task },
      },
    },
  }
}

function taskAt(tasks: DeepReadonly<TasksState>, ref: TaskRef): DeepReadonly<TaskRecord> | undefined {
  const source = own(tasks.bySource, ref.source)
  return source === undefined ? undefined : own(source, ref.id)
}

function own<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function sameTask(left: DeepReadonly<TaskRecord>, right: TaskRecord): boolean {
  return (
    Task.sameRef(left.ref, right.ref) &&
    left.title === right.title &&
    left.description === right.description &&
    left.url === right.url &&
    left.revision === right.revision &&
    sameStrings(left.labels, right.labels)
  )
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function parseLabels(input: unknown): readonly string[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) throw new Error("yrd: task 'labels' must be an array of non-empty strings")
  return input.map((label) => parseNonEmptyString(label, "task label"))
}

function optionalString(input: unknown, field: string): string | undefined {
  if (input === undefined) return undefined
  if (typeof input !== "string") throw new Error(`yrd: ${field} must be a string`)
  return input
}

function parseNonEmptyString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim() === "") throw new Error(`yrd: ${field} must not be empty`)
  return input
}

function plainObject(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`yrd: ${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`yrd: ${label} must be a plain object`)
  return input as Record<string, unknown>
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown !== undefined) throw new Error(`yrd: ${label} has unknown field '${unknown}'`)
}

function formatRef(ref: TaskRef): string {
  return `${ref.source}:${ref.id}`
}
