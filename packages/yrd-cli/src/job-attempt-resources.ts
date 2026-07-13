import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { JobAttempt, JobAttemptResources } from "@yrd/job"
import { createExclusive } from "@yrd/persistence"

export type JobAttemptResourceHost = JobAttemptResources &
  Readonly<{
    path(attempt: JobAttempt): string
    environment(attempt: JobAttempt): Readonly<Record<string, string>>
  }>

type RuntimeRegistration = Readonly<{
  schema: 1
  token: string
  phase: "registered" | "finalized"
  owner?: unknown
}>

type JobAttemptResourceOptions = Readonly<{
  stateDir: string
  runtimeReleaseTimeoutMs?: number
  runtimeReleasePollMs?: number
}>

const DEFAULT_RUNTIME_RELEASE_TIMEOUT_MS = 30_000
const DEFAULT_RUNTIME_RELEASE_POLL_MS = 10

/** Filesystem adapter for resources that must not outlive one durable attempt. */
export function createJobAttemptResources(options: JobAttemptResourceOptions): JobAttemptResourceHost {
  const attemptsRoot = join(resolve(options.stateDir), "attempts")
  const path = (attempt: JobAttempt): string =>
    join(attemptsRoot, createHash("sha256").update(attempt.id).digest("hex"), `attempt-${attempt.attempt}`)
  const registryPath = (attempt: JobAttempt): string => `${path(attempt)}.runtimes`

  return Object.freeze({
    path,
    environment(attempt) {
      const root = path(attempt)
      return Object.freeze({
        YRD_JOB_ROOT: root,
        YRD_JOB_RUNTIME_REGISTRY: registryPath(attempt),
        TMPDIR: join(root, "tmp"),
      })
    },
    async prepare(attempt) {
      const root = path(attempt)
      const registry = registryPath(attempt)
      if (existsSync(join(registry, "closing"))) {
        throw new Error(`yrd: Job attempt runtime registry is already closing (${registry})`)
      }
      await mkdir(join(root, "tmp"), { recursive: true })
      await mkdir(join(registry, "open"), { recursive: true })
      await mkdir(join(registry, "staging"), { recursive: true })
    },
    async release(attempt) {
      const root = path(attempt)
      const registry = registryPath(attempt)
      await closeRuntimeRegistry(registry)
      await rm(root, { recursive: true, force: true })
      if (existsSync(root)) throw new Error(`yrd: Job attempt root '${root}' still exists after release`)
      await drainRuntimeRegistry(registry, {
        timeoutMs: options.runtimeReleaseTimeoutMs ?? DEFAULT_RUNTIME_RELEASE_TIMEOUT_MS,
        pollMs: options.runtimeReleasePollMs ?? DEFAULT_RUNTIME_RELEASE_POLL_MS,
      })
    },
  })
}

async function closeRuntimeRegistry(registry: string): Promise<void> {
  if (!existsSync(registry)) return
  const open = join(registry, "open")
  const closing = join(registry, "closing")
  if (existsSync(open) && existsSync(closing)) {
    throw new Error(`yrd: Job attempt runtime registry has both open and closing gates (${registry})`)
  }
  if (!existsSync(open)) return
  try {
    await rename(open, closing)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

async function drainRuntimeRegistry(
  registry: string,
  options: Readonly<{ timeoutMs: number; pollMs: number }>,
): Promise<void> {
  if (!existsSync(registry)) return
  const deadline = Date.now() + Math.max(0, options.timeoutMs)
  const pollMs = Math.max(1, options.pollMs)
  const staging = join(registry, "staging")
  const closing = join(registry, "closing")

  await waitForEmpty(staging, deadline, pollMs, "runtime registration")
  for (const token of await directoryNames(closing)) {
    const entry = join(closing, token)
    const timeoutMs = Math.max(0, deadline - Date.now())
    await createExclusive(entry, { timeoutMs, pollIntervalMs: pollMs }).run(async () => {
      const registration = await readRegistration(entry, token)
      if (registration.phase !== "finalized") {
        throw new Error(
          `yrd: Job attempt runtime '${token}' exited without final acknowledgement (${JSON.stringify(registration.owner)})`,
        )
      }
    })
    await rm(entry, { recursive: true, force: true })
  }

  await waitForEmpty(closing, deadline, pollMs, "runtime release")
  await rm(registry, { recursive: true, force: true })
  if (existsSync(registry))
    {throw new Error(`yrd: Job attempt runtime registry '${registry}' still exists after release`)}
}

async function waitForEmpty(path: string, deadline: number, pollMs: number, label: string): Promise<void> {
  while ((await directoryNames(path)).length > 0) {
    if (Date.now() >= deadline) throw new Error(`yrd: timed out waiting for ${label} at ${path}`)
    await Bun.sleep(pollMs)
  }
}

async function directoryNames(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

async function readRegistration(entry: string, expectedToken: string): Promise<RuntimeRegistration> {
  const path = join(entry, "runtime.json")
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, "utf8"))
  } catch (cause) {
    throw new Error(`yrd: invalid Job attempt runtime registration '${path}'`, { cause })
  }
  if (
    !isRecord(value) ||
    value["schema"] !== 1 ||
    value["token"] !== expectedToken ||
    (value["phase"] !== "registered" && value["phase"] !== "finalized")
  ) {
    throw new Error(`yrd: invalid Job attempt runtime registration '${path}'`)
  }
  return {
    schema: 1,
    token: expectedToken,
    phase: value["phase"],
    ...(value["owner"] !== undefined ? { owner: value["owner"] } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
