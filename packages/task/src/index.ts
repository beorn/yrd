export * from "./adapters.ts"
import { Task as TaskDomain, withTasks } from "./tasks.ts"
import type { Task as TaskValue } from "./types.ts"

export const Task = TaskDomain
export { withTasks }
export type Task = TaskValue
export type { HasTasks, TaskCommands, TaskIntake, TaskRef, TasksState, TaskSource, WithTasksOptions } from "./types.ts"
