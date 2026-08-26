import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, link, mkdir, open, readFile, readdir, realpath, stat, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { systemClock, type JsonValue } from "@yrd/core"
import type { Process } from "@yrd/process"
import { createGitWorktreeStore, type GitWorktreeStoreOptions } from "git-super/worktree"
import * as z from "zod"

export type DeploymentPin = "tip" | "last-green"

export type DeploymentSubmoduleResult = Readonly<{ path: string; sha: string }>

export type DeploymentSourceResult = Readonly<{
  deploymentId: string
  generation: string
  path: string
  sha: string
  verification: "verified"
  dirty: false
  loadedAt: string
  pin: DeploymentPin
  submodules: readonly DeploymentSubmoduleResult[]
}>

export type MaterializeDeploymentInput = Readonly<{
  deploymentId: string
  generation: string
  sha: string
  pin: DeploymentPin
}>

export type ReleaseDeploymentInput = Pick<DeploymentSourceResult, "deploymentId" | "generation" | "path" | "sha">
export type ReleaseDeploymentJobInput = ReleaseDeploymentInput &
  Readonly<{
    authorization: Readonly<{
      kind: "hab-generation-release"
      generation: string
      path: string
      sha: string
      receipt: JsonValue
    }>
  }>

export type GitDeploymentStoreOptions = Readonly<{
  repo: string
  process: Pick<Process, "run">
  deploymentsRoot?: string
  env?: NodeJS.ProcessEnv
  timeouts?: GitWorktreeStoreOptions["timeouts"]
  now?: () => string
  prepare?: (path: string) => Promise<void>
}>

const FULL_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const GenerationIdSchema = z.string().trim().min(1)

const DeploymentPinSchema = z.enum(["tip", "last-green"])
export const DeploymentInputSchema = z
  .object({
    deploymentId: z.string().regex(SAFE_ID),
    generation: GenerationIdSchema,
    sha: z.string().regex(FULL_OBJECT_ID),
    pin: DeploymentPinSchema,
  })
  .strict()
const DeploymentSubmoduleResultSchema = z
  .object({ path: z.string().min(1), sha: z.string().regex(FULL_OBJECT_ID) })
  .strict()
export const DeploymentSourceResultSchema = DeploymentInputSchema.extend({
  path: z.string().min(1),
  verification: z.literal("verified"),
  dirty: z.literal(false),
  loadedAt: z.iso.datetime({ offset: true }),
  submodules: z.array(DeploymentSubmoduleResultSchema).readonly(),
}).strict()
const ReleaseDeploymentInputSchema = DeploymentSourceResultSchema.pick({
  deploymentId: true,
  generation: true,
  path: true,
  sha: true,
}).strict()
export const HabGenerationReleaseResultSchema = z
  .object({
    schema: z.literal("hab-service-generation-release/1"),
    jurisdiction: z.literal("single-habitat"),
    habitatRoot: z.string().min(1),
    retiredSource: z
      .object({
        path: z.string().min(1),
        sha: z.string().regex(FULL_OBJECT_ID),
        verification: z.literal("verified"),
      })
      .strict(),
    replacementSource: z
      .object({
        path: z.string().min(1),
        sha: z.string().regex(FULL_OBJECT_ID),
        verification: z.literal("verified"),
      })
      .strict(),
    releasedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
export const ReleaseDeploymentJobInputSchema: z.ZodType<ReleaseDeploymentJobInput> =
  ReleaseDeploymentInputSchema.extend({
    authorization: z
      .object({
        kind: z.literal("hab-generation-release"),
        generation: GenerationIdSchema,
        path: z.string().min(1),
        sha: z.string().regex(FULL_OBJECT_ID),
        receipt: HabGenerationReleaseResultSchema,
      })
      .strict(),
  }).strict()
export const ReleasedDeploymentSchema = z.object({ released: z.literal(true), path: z.string().min(1) }).strict()
export const ReapedDeploymentSchema = z.object({ reaped: z.literal(true), path: z.string().min(1) }).strict()

function validateId(kind: "deployment", value: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${kind} id '${value}' is not a safe path component`)
}

export function assertHabReleaseAuthorization(input: ReleaseDeploymentJobInput): void {
  const result = HabGenerationReleaseResultSchema.parse(input.authorization.receipt)
  const source = result.retiredSource
  if (resolve(source.path) !== resolve(input.authorization.path)) {
    throw new Error(`Hab release path '${source.path}' does not authorize '${input.authorization.path}'`)
  }
  if (source.sha !== input.authorization.sha) {
    throw new Error(`Hab release SHA '${source.sha}' does not authorize '${input.authorization.sha}'`)
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function writeResult(path: string, content: string): Promise<"created" | "exists"> {
  const directory = resolve(path, "..")
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(content, "utf8")
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await link(temporary, path)
    await syncDirectory(directory)
    return "created"
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return "exists"
    throw cause
  } finally {
    await unlink(temporary).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
    })
  }
}

async function readResult(recordsRoot: string, deploymentId: string): Promise<DeploymentSourceResult | undefined> {
  const path = join(recordsRoot, `${deploymentId}.json`)
  if (!existsSync(path)) return undefined
  return JSON.parse(await readFile(path, "utf8")) as DeploymentSourceResult
}

/** Resolve Yrd's opaque deployment identity from Hab's exact path+SHA join. */
export async function readDeploymentBySource(
  deploymentsRoot: string,
  path: string,
  sha: string,
): Promise<DeploymentSourceResult | undefined> {
  const recordsRoot = join(resolve(deploymentsRoot), "records")
  let names: string[]
  try {
    names = (await readdir(recordsRoot)).filter((name) => name.endsWith(".json")).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const matches: DeploymentSourceResult[] = []
  for (const name of names) {
    const result = DeploymentSourceResultSchema.parse(JSON.parse(await readFile(join(recordsRoot, name), "utf8")))
    if (resolve(result.path) === resolve(path) && result.sha === sha) matches.push(result)
  }
  if (matches.length > 1) {
    throw new Error(`multiple Yrd deployments claim exact source '${resolve(path)}@${sha}'`)
  }
  return matches[0]
}

/** Read every published deployment whose immutable physical path still exists. */
export async function readLiveDeployments(deploymentsRoot: string): Promise<DeploymentSourceResult[]> {
  const recordsRoot = join(resolve(deploymentsRoot), "records")
  let names: string[]
  try {
    names = (await readdir(recordsRoot)).filter((name) => name.endsWith(".json")).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const matches: DeploymentSourceResult[] = []
  for (const name of names) {
    const result = DeploymentSourceResultSchema.parse(JSON.parse(await readFile(join(recordsRoot, name), "utf8")))
    if (existsSync(result.path)) matches.push(result)
  }
  return matches.sort((left, right) => left.deploymentId.localeCompare(right.deploymentId))
}

async function submoduleClosure(
  git: Awaited<ReturnType<typeof createGitWorktreeStore>>["git"],
  path: string,
): Promise<DeploymentSubmoduleResult[]> {
  const result = await git.run(
    path,
    ["submodule", "foreach", "--recursive", "--quiet", 'printf "%s\\t%s\\n" "$displaypath" "$(git rev-parse HEAD)"'],
    true,
  )
  if (result.code !== 0) throw new Error(result.stderr.trim() || "could not inspect recursive submodule identity")
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== "")
    .map((line) => {
      const [submodulePath, sha, ...rest] = line.split("\t")
      if (submodulePath === undefined || sha === undefined || rest.length !== 0 || !FULL_OBJECT_ID.test(sha)) {
        throw new Error(`invalid recursive submodule result row '${line}'`)
      }
      return { path: submodulePath, sha }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
}

async function changeWritePermission(path: string, writable: boolean): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true })
  await Promise.all(
    entries.map(async (entry) => {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) return
      if (entry.isDirectory()) await changeWritePermission(child, writable)
      const current = await stat(child)
      await chmod(child, writable ? current.mode | 0o200 : current.mode & ~0o222)
    }),
  )
  const current = await stat(path)
  await chmod(path, writable ? current.mode | 0o200 : current.mode & ~0o222)
}

export function assertExactRelease(
  record: Pick<DeploymentSourceResult, "generation" | "path" | "sha">,
  input: Pick<DeploymentSourceResult, "generation" | "path" | "sha">,
): void {
  if (record.generation !== input.generation) {
    throw new Error(`generation '${input.generation}' does not release recorded generation '${record.generation}'`)
  }
  if (resolve(record.path) !== resolve(input.path)) {
    throw new Error(`path '${input.path}' does not release recorded path '${record.path}'`)
  }
  if (record.sha !== input.sha) throw new Error(`SHA '${input.sha}' does not release recorded SHA '${record.sha}'`)
}

export async function createGitDeploymentStore(options: GitDeploymentStoreOptions) {
  const worktrees = createGitWorktreeStore(options)
  const deploymentsRoot = resolve(options.deploymentsRoot ?? join(worktrees.repo, ".yrd-deployments"))
  const rootsRoot = join(deploymentsRoot, "roots")
  const recordsRoot = join(deploymentsRoot, "records")
  const now = options.now ?? systemClock.iso
  await mkdir(rootsRoot, { recursive: true })
  await mkdir(recordsRoot, { recursive: true })
  await worktrees.prepareRoot(deploymentsRoot)

  return Object.freeze({
    async materialize(input: MaterializeDeploymentInput): Promise<DeploymentSourceResult> {
      validateId("deployment", input.deploymentId)
      if (!FULL_OBJECT_ID.test(input.sha)) throw new Error(`deployment SHA '${input.sha}' is not a full Git object id`)
      const path = join(rootsRoot, input.deploymentId)
      const existing = await readResult(recordsRoot, input.deploymentId)
      if (existing !== undefined) {
        assertExactRelease(existing, { ...input, path })
        if (existing.pin !== input.pin) {
          throw new Error(`pin '${input.pin}' does not match recorded pin '${existing.pin}'`)
        }
        if (!existsSync(existing.path)) {
          throw new Error(`published deployment '${input.deploymentId}' is missing its exact path '${existing.path}'`)
        }
        return existing
      }

      const resolvedSha = await worktrees.git.commit(worktrees.repo, input.sha)
      if (resolvedSha !== input.sha) throw new Error(`deployment SHA '${input.sha}' resolved to '${resolvedSha}'`)
      if (!existsSync(path)) {
        await worktrees.add({
          kind: "detached",
          path,
          ref: resolvedSha,
          hooks: "quarantine",
          lockReason: `immutable Yrd deployment ${input.deploymentId}`,
          operation: `deployment ${input.deploymentId} worktree add`,
        })
      } else {
        const observed = await worktrees.inspect(path)
        if (!observed.registered || observed.head !== input.sha || observed.detached !== true) {
          throw new Error(`deployment '${input.deploymentId}' path exists without matching detached Git registration`)
        }
        if (observed.locked === undefined) {
          throw new Error(`deployment '${input.deploymentId}' recovery path is not Git-locked`)
        }
        await changeWritePermission(path, true)
      }
      await worktrees.materializeSubmodules(path, { hooks: "quarantine" })
      await options.prepare?.(path)
      const [physicalPath, headSha, status, submodules] = await Promise.all([
        realpath(path),
        worktrees.git.commit(path, "HEAD"),
        worktrees.git.run(path, ["status", "--porcelain", "--ignore-submodules=none"]),
        submoduleClosure(worktrees.git, path),
      ])
      if (headSha !== input.sha) {
        throw new Error(`materialized HEAD '${headSha}' does not match requested SHA '${input.sha}'`)
      }
      if (status.stdout.trim() !== "") {
        throw new Error(`deployment '${input.deploymentId}' is dirty after preparation:\n${status.stdout.trim()}`)
      }
      const registration = await worktrees.inspect(physicalPath)
      if (!registration.registered || registration.head !== input.sha || registration.detached !== true) {
        throw new Error(`deployment '${input.deploymentId}' lost its exact detached Git registration`)
      }
      if (registration.locked === undefined) throw new Error(`deployment '${input.deploymentId}' is not Git-locked`)
      await changeWritePermission(physicalPath, false)
      const result: DeploymentSourceResult = {
        deploymentId: input.deploymentId,
        generation: input.generation,
        path: physicalPath,
        sha: headSha,
        verification: "verified",
        dirty: false,
        loadedAt: now(),
        pin: input.pin,
        submodules,
      }
      const published = await writeResult(
        join(recordsRoot, `${input.deploymentId}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      )
      if (published === "exists") {
        const winner = await readResult(recordsRoot, input.deploymentId)
        if (winner === undefined || JSON.stringify(winner) !== JSON.stringify(result)) {
          throw new Error(`deployment '${input.deploymentId}' result publication raced with different evidence`)
        }
      }
      return result
    },

    async release(input: ReleaseDeploymentInput): Promise<Readonly<{ released: true; path: string }>> {
      validateId("deployment", input.deploymentId)
      const result = await readResult(recordsRoot, input.deploymentId)
      if (result === undefined) throw new Error(`deployment '${input.deploymentId}' has no published result`)
      assertExactRelease(result, input)
      if (existsSync(result.path)) {
        await changeWritePermission(result.path, true)
        await worktrees.remove(result.path, {
          unlock: true,
          operation: `deployment ${input.deploymentId} worktree remove`,
        })
      } else {
        await worktrees.recoverDestroyed(result.path, `deployment ${input.deploymentId} released-worktree recovery`)
      }
      return { released: true, path: result.path }
    },

    async reap(input: MaterializeDeploymentInput): Promise<Readonly<{ reaped: true; path: string }>> {
      validateId("deployment", input.deploymentId)
      if ((await readResult(recordsRoot, input.deploymentId)) !== undefined) {
        throw new Error(`deployment '${input.deploymentId}' is published and cannot be reaped as failed preparation`)
      }
      const path = join(rootsRoot, input.deploymentId)
      if (existsSync(path)) {
        await changeWritePermission(path, true)
        await worktrees.remove(path, {
          unlock: true,
          operation: `deployment ${input.deploymentId} failed worktree reap`,
        })
      } else {
        await worktrees.recoverDestroyed(path, `deployment ${input.deploymentId} failed-worktree recovery`)
      }
      return { reaped: true, path }
    },
  })
}

export type GitDeploymentStore = Awaited<ReturnType<typeof createGitDeploymentStore>>

export function deploymentJobKey(operation: "materialize" | "reap" | "release", deploymentId: string): string {
  validateId("deployment", deploymentId)
  return `deployment:${deploymentId}:${operation}`
}
