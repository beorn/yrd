import { Task } from "./tasks.ts"
import type { TaskSource } from "./types.ts"

export type TaskProcessRequest = Readonly<{ argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }>
export type TaskProcessResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>
export type TaskProcessRunner = (request: TaskProcessRequest) => Promise<TaskProcessResult>

type SourceOptions = Readonly<{
  id?: string
  command?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  process?: TaskProcessRunner
}>

const run: TaskProcessRunner = async ({ argv, cwd, env }) => {
  const child = Bun.spawn([...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

function source(
  options: SourceOptions & {
    id: string
    argv(id: string): readonly string[]
    project(value: unknown, ref: ReturnType<typeof Task.ref>): unknown
  },
): TaskSource {
  return {
    id: options.id,
    async resolve(ref) {
      if (ref.source !== options.id) throw new Error(`yrd: task source '${options.id}' cannot resolve '${ref.source}'`)
      const env = Object.fromEntries(
        Object.entries({ ...process.env, ...options.env }).filter(
          ([key, value]) => value !== undefined && !key.startsWith("GIT_") && !key.startsWith("YRD_"),
        ),
      )
      const result = await (options.process ?? run)({
        argv: options.argv(ref.id),
        cwd: options.cwd ?? process.cwd(),
        env: { ...env, YRD_TASK_SOURCE: ref.source, YRD_TASK_ID: ref.id },
      })
      if (result.exitCode !== 0)
        throw new Error(
          `yrd: task source '${options.id}' exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
        )
      let value: unknown
      try {
        value = JSON.parse(result.stdout)
      } catch {
        throw new Error(`yrd: task source '${options.id}' returned invalid JSON for '${ref.id}'`)
      }
      return Task.parse(options.project(value, ref))
    },
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`yrd: ${label} must be an object`)
  return value as Record<string, unknown>
}

export function createCommandTaskSource(
  options: SourceOptions & { id: string; command: readonly string[] },
): TaskSource {
  if (options.command.length === 0) throw new Error("yrd: task source command must not be empty")
  return source({
    ...options,
    argv: (id) => [...options.command, id],
    project: (value, ref) => ({ ...record(value, "task JSON"), ref }),
  })
}

export function createKmTaskSource(options: SourceOptions = {}): TaskSource {
  const id = options.id ?? "km"
  const command = options.command ?? ["km"]
  return source({
    ...options,
    id,
    argv: (task) => [...command, "show", "--one", "--context", "--json", task],
    project(value, ref) {
      const context = record(value, "km task JSON")
      const node = record(context.node, "km task node")
      const blocks = Array.isArray(context.blocks) ? context.blocks : []
      const block = blocks.length === 0 ? undefined : record(blocks.at(-1), "km task block")
      const data = node.data === undefined ? {} : record(node.data, "km task data")
      return {
        ref,
        title: node.title ?? node.content ?? node.name,
        ...(Array.isArray(block?.body) ? { description: block.body.join("\n").trim() } : {}),
        ...(data.url === undefined ? {} : { url: data.url }),
        ...(data.labels === undefined ? {} : { labels: data.labels }),
        ...(node.version === undefined && node.updated_at === undefined
          ? {}
          : { revision: String(node.version ?? node.updated_at) }),
      }
    },
  })
}
