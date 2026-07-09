import type { Task, TaskRef, TaskSource } from "./types.ts"

export type TaskProcessRequest = Readonly<{
  kind: "task"
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}>

export type TaskProcessResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
}>

export type TaskProcessRunner = (request: TaskProcessRequest) => Promise<TaskProcessResult>

export type CommandTaskSourceOptions = Readonly<{
  id: string
  /** Executable and static arguments. The opaque task id is appended as one argv value. */
  command: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  process?: TaskProcessRunner
}>

export type KmTaskSourceOptions = Readonly<{
  id?: string
  /** Executable and static prefix. Defaults to the installed `km` command. */
  command?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  process?: TaskProcessRunner
}>

type JsonRecord = Record<string, unknown>

const defaultProcess: TaskProcessRunner = async (request) => {
  const child = Bun.spawn([...request.argv], {
    cwd: request.cwd,
    env: request.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`yrd: ${label} must be a non-empty string`)
  return value.trim()
}

function commandArgv(command: readonly string[], label: string): readonly string[] {
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part.trim() === "")) {
    throw new Error(`yrd: ${label} must contain only non-empty argv values`)
  }
  return [...command]
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`yrd: ${label} must be an object`)
  }
  return value as JsonRecord
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return nonEmpty(value, label)
}

function optionalLabels(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`yrd: ${label} must be an array of non-empty strings`)
  }
  return value.map((item) => (item as string).trim())
}

function parseJson(stdout: string, source: string, id: string): unknown {
  const text = stdout.trim()
  if (text === "") throw new Error(`yrd: task source '${source}' returned no JSON for '${id}'`)
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`yrd: task source '${source}' returned invalid JSON for '${id}': ${detail}`)
  }
}

function processError(source: string, id: string, result: TaskProcessResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostic output"
  return new Error(`yrd: task source '${source}' command for '${id}' exited ${result.exitCode}: ${detail}`)
}

function environment(ref: TaskRef, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const source of [process.env, extra]) {
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith("GIT_") || key.startsWith("YRD_")) continue
      env[key] = value
    }
  }
  return {
    ...env,
    YRD_TASK_SOURCE: ref.source,
    YRD_TASK_ID: ref.id,
  }
}

function validateRef(source: string, ref: TaskRef): void {
  if (ref.source !== source) {
    throw new Error(`yrd: task source '${source}' cannot resolve task source '${ref.source}'`)
  }
  nonEmpty(ref.id, `task source '${source}' task id`)
}

async function executeTask(
  source: string,
  ref: TaskRef,
  argv: readonly string[],
  options: Pick<CommandTaskSourceOptions, "cwd" | "env" | "process">,
): Promise<unknown> {
  validateRef(source, ref)
  let result: TaskProcessResult
  try {
    result = await (options.process ?? defaultProcess)({
      kind: "task",
      argv,
      cwd: options.cwd ?? process.cwd(),
      env: environment(ref, options.env),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`yrd: task source '${source}' command for '${ref.id}' could not run: ${detail}`)
  }
  if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) throw processError(source, ref.id, result)
  return parseJson(result.stdout, source, ref.id)
}

function optionalReturnedRef(value: unknown, requested: TaskRef, source: string): void {
  if (value === undefined) return
  const returned = record(value, `task source '${source}' JSON 'ref'`)
  const returnedSource = nonEmpty(returned.source, `task source '${source}' JSON 'ref.source'`)
  const returnedId = nonEmpty(returned.id, `task source '${source}' JSON 'ref.id'`)
  if (returnedSource !== requested.source || returnedId !== requested.id) {
    throw new Error(
      `yrd: task source '${source}' returned '${returnedSource}:${returnedId}' for '${requested.source}:${requested.id}'`,
    )
  }
}

function commandTask(value: unknown, ref: TaskRef, source: string): Task {
  const json = record(value, `task source '${source}' JSON`)
  optionalReturnedRef(json.ref, ref, source)
  const title = nonEmpty(json.title, `task source '${source}' JSON 'title'`)
  const description = optionalString(json.description, `task source '${source}' JSON 'description'`)
  const url = optionalString(json.url, `task source '${source}' JSON 'url'`)
  const labels = optionalLabels(json.labels, `task source '${source}' JSON 'labels'`)
  const revision = optionalString(json.revision, `task source '${source}' JSON 'revision'`)
  return {
    ref,
    title,
    ...(description === undefined ? {} : { description }),
    ...(url === undefined ? {} : { url }),
    ...(labels === undefined ? {} : { labels }),
    ...(revision === undefined ? {} : { revision }),
  }
}

function kmTask(value: unknown, ref: TaskRef, source: string): Task {
  const context = record(value, `task source '${source}' JSON`)
  const node = record(context.node, `task source '${source}' JSON 'node'`)
  const title = optionalString(node.title, `task source '${source}' JSON 'title'`)
    ?? optionalString(node.content, `task source '${source}' JSON 'title'`)
    ?? optionalString(node.name, `task source '${source}' JSON 'title'`)
  if (title === undefined) throw new Error(`yrd: task source '${source}' JSON 'title' must be a non-empty string`)

  let description: string | undefined
  if (context.blocks !== undefined) {
    if (!Array.isArray(context.blocks)) throw new Error(`yrd: task source '${source}' JSON 'blocks' must be an array`)
    const target = context.blocks.at(-1)
    if (target !== undefined) {
      const block = record(target, `task source '${source}' JSON target block`)
      if (!Array.isArray(block.body) || block.body.some((line) => typeof line !== "string")) {
        throw new Error(`yrd: task source '${source}' JSON target block 'body' must be an array of strings`)
      }
      const body = (block.body as string[]).join("\n").trim()
      if (body !== "") description = body
    }
  }

  const data = node.data === undefined ? {} : record(node.data, `task source '${source}' JSON 'node.data'`)
  const url = optionalString(data.url, `task source '${source}' JSON 'node.data.url'`)
  const labels = optionalLabels(data.labels, `task source '${source}' JSON 'node.data.labels'`)
  const revision = optionalString(node.version, `task source '${source}' JSON 'node.version'`)
    ?? (typeof node.updated_at === "number" && Number.isFinite(node.updated_at) ? String(node.updated_at) : undefined)
  return {
    ref,
    title,
    ...(description === undefined ? {} : { description }),
    ...(url === undefined ? {} : { url }),
    ...(labels === undefined ? {} : { labels }),
    ...(revision === undefined ? {} : { revision }),
  }
}

/** Resolve canonical task JSON from any argv-only local command. */
export function createCommandTaskSource(options: CommandTaskSourceOptions): TaskSource {
  const id = nonEmpty(options.id, "command task source id")
  const command = commandArgv(options.command, `task source '${id}' command`)
  return {
    id,
    async resolve(ref) {
      const value = await executeTask(id, ref, [...command, ref.id], options)
      return commandTask(value, ref, id)
    },
  }
}

/** Resolve a km node through `km show --one --context --json`. */
export function createKmTaskSource(options: KmTaskSourceOptions = {}): TaskSource {
  const id = nonEmpty(options.id ?? "km", "km task source id")
  const command = commandArgv(options.command ?? ["km"], `task source '${id}' command`)
  return {
    id,
    async resolve(ref) {
      const argv = [...command, "show", "--one", "--context", "--json", ref.id]
      const value = await executeTask(id, ref, argv, options)
      return kmTask(value, ref, id)
    },
  }
}
