import type { Command } from "@yrd/core"

/** Stable identity supplied by a task source. `source` names an adapter
 * instance; `id` is opaque to Yrd and retains the source's native identity. */
export type TaskRef = Readonly<{
  source: string
  id: string
}>

/** Canonical task context consumed by Yrd workflows. Tracker-specific fields
 * are mapped into this shape at the adapter boundary. */
export type Task = Readonly<{
  ref: TaskRef
  title: string
  description?: string
  url?: string
  labels?: readonly string[]
  revision?: string
}>

/** Adapter contract for km, GitHub, local stores, or another source of tasks. */
export type TaskSource = Readonly<{
  id: string
  resolve(ref: TaskRef): Task | undefined | Promise<Task | undefined>
}>

export type TasksState = {
  bySource: Record<string, Record<string, Task>>
}

export type TaskCommands = {
  task: {
    record: Command<Task, { tasks: TasksState }>
  }
}

export type TaskIntake = {
  register(source: TaskSource): void
  record(task: Task): Promise<Task>
  intake(ref: TaskRef): Promise<Task>
  get(ref: TaskRef): Promise<Task | undefined>
  list(): Promise<readonly Task[]>
}

export type HasTasks = {
  initialState: { tasks: TasksState }
  commands: TaskCommands
  tasks: TaskIntake
}

export type WithTasksOptions = {
  sources?: readonly TaskSource[]
}
