export type TaskRef = Readonly<{ source: string; id: string }>

export type Task = Readonly<{
  ref: TaskRef
  title: string
  description?: string
  url?: string
  labels?: readonly string[]
  revision?: string
}>

export type TaskSource = Readonly<{
  id: string
  resolve(ref: TaskRef): Task | undefined | Promise<Task | undefined>
}>

export type TaskResolver = Readonly<{
  ref(input: string): TaskRef
  resolve(ref: TaskRef): Promise<Task>
  sources: readonly string[]
}>

export type HasTasks = { tasks: TaskResolver }
export type WithTasksOptions = Readonly<{ sources?: readonly TaskSource[]; defaultSource?: string }>
