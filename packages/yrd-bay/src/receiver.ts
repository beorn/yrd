import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { createExclusive } from "@yrd/persistence"
import type { Process } from "@yrd/process"
import * as z from "zod"
import { GitRefSchema, GitShaSchema } from "./model.ts"

const RECEIVER_VERSION = 1 as const
const RESULT_VERSION = 1 as const
const MANAGED_HOOK_MARKER = "// yrd-managed-receiver-hook:1"
const MANAGED_HOOK_PREFIX = "#!/usr/bin/env bun\n// yrd-managed-receiver-hook:"
const BRANCH_PREFIX = "refs/heads/"
/**
 * Gerrit's submit namespace, adopted verbatim per the git-layer compatibility
 * ruling: a push to `refs/for/<base>/<change>` IS the submission, so a change
 * that is pushed but unsubmitted has no representation at all.
 */
const SUBMIT_PREFIX = "refs/for/"
const ZERO_SHA = /^0+$/u
const HEX_SHA = /^[0-9a-f]+$/u
const REPOSITORY_ENV =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|COMMON_DIR|NAMESPACE|PREFIX|IMPLICIT_WORK_TREE)$/u

type Environment = Record<string, string | undefined>
type HookMode = "pre-receive" | "post-receive"
type ResultState = "prepared" | "pending"

const TextSchema = z.string().trim().min(1)
const ReceiverRefUpdateSchema = z
  .object({ oldSha: z.string().regex(HEX_SHA), newSha: z.string().regex(HEX_SHA), ref: TextSchema })
  .strict()
const ReceiverTargetSchema = z
  .object({
    bay: TextSchema.optional(),
    name: TextSchema.optional(),
    /**
     * The issue this change belongs to. A `refs/for/<base>/<change>` push names
     * one in the ref itself, and dropping it here would mean yrd forgot the
     * only thing the push carried beyond its commits.
     */
    issue: TextSchema.optional(),
    base: GitRefSchema,
    baseSha: GitShaSchema,
    /**
     * The carrier branch this change lands on. A `refs/heads/` push already
     * names its branch in the ref, so this stays absent there. A `refs/for/`
     * push does NOT — the ref names the change — so the resolver, which is
     * what opens the bay, is the only party that knows it.
     */
    branch: GitRefSchema.optional(),
  })
  .strict()
const ReceiverResultSchema = z
  .object({
    version: z.literal(RESULT_VERSION),
    id: z.string().regex(/^[0-9a-f]{64}$/u),
    receivedAt: z.iso.datetime({ offset: true }),
    ref: TextSchema,
    branch: GitRefSchema,
    /**
     * The change name parsed out of a `refs/for/<base>/<change>` push. Stored
     * so the result's identity check stays a pure function of the result:
     * without it, a submit result could only be checked against its base, and
     * a result that cannot fully check its own ref is a result that can lie.
     */
    change: TextSchema.optional(),
    oldSha: GitShaSchema,
    headSha: GitShaSchema,
    intake: ReceiverTargetSchema.extend({
      branch: GitRefSchema,
      headSha: GitShaSchema,
      /** Present only when the accepted ref itself was the submission act. */
      submit: z.literal(true).optional(),
    }).strict(),
  })
  .strict()

export type ReceiverRefUpdate = z.infer<typeof ReceiverRefUpdateSchema>
export type ReceiverTarget = z.infer<typeof ReceiverTargetSchema>
export type ReceiverResult = z.infer<typeof ReceiverResultSchema>
export type GitPushReceiver = Readonly<{
  version: typeof RECEIVER_VERSION
  receiverPath: string
  mainRepo: string
  stateDir: string
  inboxDir: string
  objectFormat: "sha1" | "sha256"
  shaLength: 40 | 64
  process: Pick<Process, "run">
  prepare(input: string | readonly ReceiverRefUpdate[], options: ReceiverHookOptions): Promise<ReceiverResult[]>
  finalize(input: string | readonly ReceiverRefUpdate[], options: ReceiverHookOptions): Promise<ReceiverResult[]>
  drain(
    options: ReceiverHookOptions & { intake: DurableReceiverIntake; lockTimeoutMs?: number },
  ): Promise<ReceiverDrainResult>
}>
/**
 * What a `refs/for/<base>/<change>` push asks for, parsed out of the ref.
 *
 * Present only for submit pushes. Its absence is the signal that the resolver
 * is being asked the OLD question — "does an active bay track this branch?" —
 * and its presence is the signal that no bay exists yet and admission is what
 * creates one.
 */
export type ReceiverSubmitIntent = Readonly<{ base: string; name: string }>
export type ResolveReceiverTarget = (
  branch: string,
  update: Readonly<ReceiverRefUpdate>,
  intent?: ReceiverSubmitIntent,
) => ReceiverTarget | null | undefined | Promise<ReceiverTarget | null | undefined>

/**
 * Judge the pushed head's own `.yrd.yml` — its raw text, or undefined when the
 * pushed tree has none (a real, valid answer: no file means the built-in
 * defaults, the same as `loadYrdConfig` reading a base with no config). Throw
 * to refuse the push; the receiver never parses config itself (`@yrd/bay`
 * cannot depend on `@yrd/cli`'s schema without a cycle), only reads the blob
 * and hands it to whichever schema the caller owns.
 */
export type ReceiverConfigValidator = (yaml: string | undefined) => void | Promise<void>

/** Intake must atomically deduplicate result.id with its own durable event. */
export type DurableReceiverIntake = (result: Readonly<ReceiverResult>) => void | Promise<void>
export type ReceiverHookOptions = {
  resolveTarget: ResolveReceiverTarget
  intake?: DurableReceiverIntake
  clock?: () => string
  env?: Environment
  /**
   * One sentence naming what intake requires, rendered into the refusal when
   * `resolveTarget` declines a branch. The receiver cannot know the reason —
   * authorization is the resolver's to define — so the policy travels from
   * whoever owns it. Omit and the refusal is unchanged.
   */
  intakePolicy?: string
  /**
   * Judge the pushed head's `.yrd.yml` before the push is accepted. Omit and
   * the receiver reads and stores the push unjudged, exactly as it always
   * has — this gate is additive, never a default behavior change for a caller
   * that has not wired a schema in yet.
   */
  validateConfig?: ReceiverConfigValidator
}
export type ReceiverDrainResult = {
  delivered: string[]
  failed: Array<{ id: string; error: string }>
  ambiguous: string[]
}

type ReceiverOptions = Readonly<{
  mainRepo: string
  stateDir: string
  process: Pick<Process, "run">
  receiverPath?: string
  inboxDir?: string
  /** Yrd entry the managed hook re-invokes; defaults to the worktree-anchored `bin/yrd`. */
  hookEntry?: string
}>

/**
 * Absolute path to the `bin/yrd` entry of the Yrd checkout that owns THIS module.
 *
 * The managed receive hook re-invokes Yrd in a fresh process that cold-replays
 * the journal and statically imports `@yrd/bay`. Resolving that entry through
 * the ambient `PATH` (the previous `["yrd", …]` spawn) let a push validated from
 * one linked worktree load `@yrd/bay` from a *different* (mutable) checkout — the
 * hermeticity leak in @yrd/core/21170. Anchoring to `import.meta` binds the hook
 * to the worktree whose code wrote it, mirroring the source-root walk in
 * `@yrd/cli`'s version identity. A missing entry is raised loudly; it never
 * silently falls back to a parent Git repository.
 */
export function defaultReceiverHookEntry(): string {
  let directory = import.meta.dirname
  for (;;) {
    if (existsSync(join(directory, "bin", "yrd"))) return join(directory, "bin", "yrd")
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error(`yrd: receiver: unable to locate the owning Yrd 'bin/yrd' from '${import.meta.dirname}'`)
    }
    directory = parent
  }
}

export function receiverHookSource(mode: HookMode, entry: string): string {
  check(entry.length > 0, "receiver hook entry must be a non-empty path")
  return [
    "#!/usr/bin/env bun",
    MANAGED_HOOK_MARKER,
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(entry)}, "receiver-hook", "${mode}"], {`,
    '  stdin: "inherit",',
    '  stdout: "inherit",',
    '  stderr: "inherit",',
    "  env: process.env,",
    "})",
    "process.exit(await child.exited)",
    "",
  ].join("\n")
}

export async function createGitPushReceiver(options: ReceiverOptions): Promise<GitPushReceiver> {
  const hookEntry = options.hookEntry ?? defaultReceiverHookEntry()
  const requestedState = resolve(options.stateDir)
  await mkdir(requestedState, { recursive: true, mode: 0o700 })
  const mainRepo = await realpath(resolve(options.mainRepo))
  const stateDir = await realpath(requestedState)
  const receiverPath = resolve(options.receiverPath ?? join(stateDir, "prs.git"))
  const inboxDir = resolve(options.inboxDir ?? join(stateDir, "receiver-inbox"))
  const mainFormat = parseObjectFormat(
    (await mainGit(options.process, mainRepo, ["rev-parse", "--show-object-format"])).stdout,
  )
  const exclusive = createExclusive(join(stateDir, "receiver-init"), { timeoutMs: 30_000, pollIntervalMs: 10 })
  return exclusive.run(async () => {
    const current = await entry(receiverPath)
    check(!current?.isSymbolicLink(), `will not use a symlinked prs.git at '${receiverPath}'`)
    check(current === undefined || current.isDirectory(), `'${receiverPath}' exists and is not a directory`)
    if (current === undefined) {
      await mkdir(dirname(receiverPath), { recursive: true, mode: 0o700 })
      await mkdir(receiverPath, { mode: 0o700 })
      await exec(
        options.process,
        ["git", "init", "--bare", "--initial-branch=main", `--object-format=${mainFormat.objectFormat}`, receiverPath],
        dirname(receiverPath),
      )
    }
    const receiverFormat = await bareFormat(options.process, receiverPath)
    check(
      receiverFormat.objectFormat === mainFormat.objectFormat,
      `object format mismatch: main uses ${mainFormat.objectFormat}, prs.git uses ${receiverFormat.objectFormat}`,
    )
    const receiver = createReceiver({
      version: RECEIVER_VERSION,
      receiverPath,
      mainRepo,
      stateDir,
      inboxDir,
      process: options.process,
      ...receiverFormat,
    })
    await validateBinding(receiver)
    await preflightHooks(receiverPath, hookEntry)
    await mkdir(inboxDir, { recursive: true, mode: 0o700 })
    for (const [key, value] of receiverConfig(receiver)) {
      await receiverGit(receiver, ["config", "--local", key, value])
    }
    if (
      (await mainGit(options.process, mainRepo, ["for-each-ref", "--format=%(refname)", "refs/heads"])).stdout !== ""
    ) {
      await receiverGit(receiver, ["fetch", "--quiet", "--no-tags", mainRepo, "+refs/heads/*:refs/yrd/bases/*"])
    }
    await writeHook(receiverPath, "pre-receive", hookEntry)
    await writeHook(receiverPath, "post-receive", hookEntry)
    return receiver
  })
}

export async function loadGitPushReceiver(path: string, process: Pick<Process, "run">): Promise<GitPushReceiver> {
  const receiverPath = resolve(path)
  check((await entry(receiverPath))?.isDirectory(), `prs.git is not a real directory at '${receiverPath}'`)
  const format = await bareFormat(process, receiverPath)
  const version = await requiredConfig(process, receiverPath, "yrd.receiverVersion")
  check(version === String(RECEIVER_VERSION), `unsupported receiver version '${version}' at '${receiverPath}'`)
  const receiver = createReceiver({
    version: RECEIVER_VERSION,
    receiverPath,
    mainRepo: resolve(await requiredConfig(process, receiverPath, "yrd.mainRepo")),
    stateDir: resolve(await requiredConfig(process, receiverPath, "yrd.stateDir")),
    inboxDir: resolve(await requiredConfig(process, receiverPath, "yrd.inboxDir")),
    process,
    ...format,
  })
  await mkdir(receiver.inboxDir, { recursive: true, mode: 0o700 })
  return receiver
}

type ReceiverData = Pick<
  GitPushReceiver,
  "version" | "receiverPath" | "mainRepo" | "stateDir" | "inboxDir" | "objectFormat" | "shaLength" | "process"
>

function createReceiver(data: ReceiverData): GitPushReceiver {
  const receiver: GitPushReceiver = Object.freeze({
    ...data,
    prepare: (input, options) => prepareReceiverUpdates(receiver, input, options),
    finalize: (input, options) => finalizeReceiverUpdates(receiver, input, options),
    drain: (options) => drainReceiverInbox(receiver, options),
  })
  return receiver
}

export function parseReceiverUpdates(input: string): ReceiverRefUpdate[] {
  const refs = new Set<string>()
  return input
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(/\s+/u)
      check(parts.length === 3, `malformed receive entry '${entry}'`)
      const [oldSha, newSha, ref] = parts as [string, string, string]
      check(HEX_SHA.test(oldSha) && HEX_SHA.test(newSha), `malformed commit id in receive entry '${entry}'`)
      check(!refs.has(ref), `duplicate update for '${ref}'`)
      refs.add(ref)
      return ReceiverRefUpdateSchema.parse({ oldSha, newSha, ref })
    })
}

async function prepareReceiverUpdates(
  receiver: GitPushReceiver,
  input: string | readonly ReceiverRefUpdate[],
  options: ReceiverHookOptions,
): Promise<ReceiverResult[]> {
  const clock = options.clock ?? (() => new Date().toISOString())
  const created: string[] = []
  const results: ReceiverResult[] = []
  try {
    for (const value of typeof input === "string" ? parseReceiverUpdates(input) : input) {
      const update = ReceiverRefUpdateSchema.parse(value)
      const result = makeResult(update, await authorize(receiver, update, options, "before"), clock)
      const stored = await storeResult(receiver, "prepared", result)
      if (stored.created) created.push(stored.path)
      results.push(result)
    }
    return results
  } catch (cause) {
    for (const path of created) await rm(path, { force: true })
    if (created.length > 0) await syncDir(receiver.inboxDir)
    throw cause
  }
}

async function finalizeReceiverUpdates(
  receiver: GitPushReceiver,
  input: string | readonly ReceiverRefUpdate[],
  options: ReceiverHookOptions,
): Promise<ReceiverResult[]> {
  const clock = options.clock ?? (() => new Date().toISOString())
  const results: ReceiverResult[] = []
  for (const value of typeof input === "string" ? parseReceiverUpdates(input) : input) {
    const update = ReceiverRefUpdateSchema.parse(value)
    const id = resultId(update)
    const path = resultPath(receiver, "prepared", id)
    let result: ReceiverResult
    if (await entry(path)) {
      result = await readResult(path, id)
      const stored = updateOf(result)
      check(
        stored.oldSha === update.oldSha && stored.newSha === update.newSha && stored.ref === update.ref,
        `prepared result '${id}' does not match post-receive input`,
      )
      const current = await refValue(receiver, update.ref, options.env)
      check(
        current === update.newSha,
        `post-receive ref '${update.ref}' is ${current ?? "missing"}, expected ${update.newSha}`,
      )
      await validateStored(receiver, result, options)
    } else {
      result = makeResult(update, await authorize(receiver, update, options, "after"), clock)
      await storeResult(receiver, "prepared", result)
    }
    await moveResult(receiver, result, "prepared", "pending")
    results.push(result)
  }
  if (options.intake) await receiver.drain({ ...options, intake: options.intake })
  return results
}

async function drainReceiverInbox(
  receiver: GitPushReceiver,
  options: ReceiverHookOptions & { intake: DurableReceiverIntake; lockTimeoutMs?: number },
): Promise<ReceiverDrainResult> {
  await mkdir(receiver.inboxDir, { recursive: true, mode: 0o700 })
  const drain: ReceiverDrainResult = { delivered: [], failed: [], ambiguous: [] }
  const exclusive = createExclusive(join(receiver.inboxDir, "drain-lock"), {
    timeoutMs: options.lockTimeoutMs ?? 0,
    pollIntervalMs: 10,
  })
  return exclusive.run(async () => {
    await recoverPrepared(receiver, options, drain)
    const blocked = new Set<string>()
    for (const { path, result } of await pendingResults(receiver, drain)) {
      if (blocked.has(result.branch)) {
        drain.failed.push({
          id: result.id,
          error: `blocked by an earlier failed result for branch '${result.branch}'`,
        })
        continue
      }
      try {
        await validateStored(receiver, result, options)
        await options.intake(result)
        await rm(path)
        await syncDir(receiver.inboxDir)
        drain.delivered.push(result.id)
      } catch (cause) {
        blocked.add(result.branch)
        drain.failed.push({ id: result.id, error: message(cause) })
      }
    }
    return drain
  })
}

export async function runReceiverHookFromEnvironment(
  mode: HookMode,
  options: ReceiverHookOptions & { input?: string; process: Pick<Process, "run"> },
): Promise<ReceiverResult[]> {
  const env = options.env ?? process.env
  check(env.GIT_DIR, "GIT_DIR is missing in receive-hook environment")
  const receiver = await loadGitPushReceiver(resolve(process.cwd(), env.GIT_DIR), options.process)
  const input = options.input ?? (await Bun.stdin.text())
  if (mode === "pre-receive") return receiver.prepare(input, { ...options, env })
  if (mode === "post-receive") return receiver.finalize(input, { ...options, env })
  throw new Error(`yrd: receiver: unsupported hook mode '${String(mode)}'`)
}

type Result = { code: number; stdout: string; stderr: string }
type ExecOptions = { env?: Environment; allowFailure?: boolean }
type StoredResult = { path: string; result: ReceiverResult }
const GIT_TIMEOUT_MS = 30_000

function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`yrd: receiver: ${detail}`)
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function code(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined
}

async function exec(
  process: Pick<Process, "run">,
  argv: readonly string[],
  cwd: string,
  options: ExecOptions = {},
): Promise<Result> {
  const completed = await process.run({ argv, cwd, env: options.env ?? gitEnv(), timeoutMs: GIT_TIMEOUT_MS })
  if (completed.timedOut) throw new Error(`yrd: ${argv.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  const result = { code: completed.exitCode, stdout: completed.stdout.trim(), stderr: completed.stderr.trim() }
  check(
    options.allowFailure || completed.exitCode === 0,
    `${argv.join(" ")} failed: ${result.stderr || result.stdout || `exit ${completed.exitCode}`}`,
  )
  return result
}

function gitEnv(source: Environment = process.env, keepObjects = false): Environment {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        value !== undefined &&
        (!REPOSITORY_ENV.test(key) ||
          (keepObjects && (key === "GIT_OBJECT_DIRECTORY" || key === "GIT_ALTERNATE_OBJECT_DIRECTORIES"))),
    ),
  )
}

async function mainGit(
  process: Pick<Process, "run">,
  repo: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<Result> {
  return exec(process, ["git", "-C", repo, ...args], repo, { ...options, env: gitEnv(options.env) })
}

async function receiverGit(
  receiver: Pick<GitPushReceiver, "receiverPath" | "mainRepo" | "process">,
  args: readonly string[],
  options: ExecOptions & { includeMainObjects?: boolean } = {},
): Promise<Result> {
  const { includeMainObjects, ...rest } = options
  const env = includeMainObjects ? await objectEnv(receiver, options.env) : gitEnv(options.env, true)
  return exec(receiver.process, ["git", `--git-dir=${receiver.receiverPath}`, ...args], receiver.receiverPath, {
    ...rest,
    env,
  })
}

async function objectEnv(
  receiver: Pick<GitPushReceiver, "mainRepo" | "process">,
  source: Environment = process.env,
): Promise<Environment> {
  const objects = resolve(
    receiver.mainRepo,
    (await mainGit(receiver.process, receiver.mainRepo, ["rev-parse", "--git-path", "objects"], { env: source }))
      .stdout,
  )
  const env = gitEnv(source, true)
  const escaped =
    objects.includes(delimiter) || objects.includes('"') || objects.includes("\\") ? JSON.stringify(objects) : objects
  env.GIT_ALTERNATE_OBJECT_DIRECTORIES = [source.GIT_ALTERNATE_OBJECT_DIRECTORIES, escaped]
    .filter(Boolean)
    .join(delimiter)
  return env
}

async function entry(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (cause) {
    if (code(cause) === "ENOENT") return undefined
    throw cause
  }
}

function parseObjectFormat(raw: string): { objectFormat: "sha1" | "sha256"; shaLength: 40 | 64 } {
  check(raw === "sha1" || raw === "sha256", `unsupported Git object format '${raw}'`)
  return raw === "sha1" ? { objectFormat: raw, shaLength: 40 } : { objectFormat: raw, shaLength: 64 }
}

async function bareFormat(
  process: Pick<Process, "run">,
  path: string,
): Promise<{ objectFormat: "sha1" | "sha256"; shaLength: 40 | 64 }> {
  const bare = await exec(process, ["git", `--git-dir=${path}`, "rev-parse", "--is-bare-repository"], path, {
    allowFailure: true,
  })
  check(bare.code === 0 && bare.stdout === "true", `'${path}' exists but is not a bare Git repository`)
  return parseObjectFormat(
    (await exec(process, ["git", `--git-dir=${path}`, "rev-parse", "--show-object-format"], path)).stdout,
  )
}

function receiverConfig(receiver: GitPushReceiver): ReadonlyArray<readonly [string, string]> {
  return [
    ["yrd.receiverVersion", String(RECEIVER_VERSION)],
    ["yrd.stateDir", receiver.stateDir],
    ["yrd.mainRepo", receiver.mainRepo],
    ["yrd.inboxDir", receiver.inboxDir],
    ["receive.advertisePushOptions", "true"],
    ["receive.denyDeletes", "true"],
    ["receive.denyNonFastForwards", "false"],
    ["receive.fsckObjects", "true"],
    ["transfer.fsckObjects", "true"],
    ["core.logAllRefUpdates", "true"],
  ]
}

async function config(process: Pick<Process, "run">, path: string, key: string): Promise<string | undefined> {
  const result = await exec(process, ["git", `--git-dir=${path}`, "config", "--local", "--get", key], path, {
    allowFailure: true,
  })
  check(
    result.code === 0 || (result.code === 1 && result.stdout === ""),
    `cannot read config '${key}': ${result.stderr || result.stdout}`,
  )
  return result.code === 0 ? result.stdout : undefined
}

async function requiredConfig(process: Pick<Process, "run">, path: string, key: string): Promise<string> {
  const value = await config(process, path, key)
  check(value, `'${path}' is missing required config '${key}'`)
  return value
}

async function validateBinding(receiver: GitPushReceiver): Promise<void> {
  const version = await config(receiver.process, receiver.receiverPath, "yrd.receiverVersion")
  const state = await config(receiver.process, receiver.receiverPath, "yrd.stateDir")
  const main = await config(receiver.process, receiver.receiverPath, "yrd.mainRepo")
  const inbox = await config(receiver.process, receiver.receiverPath, "yrd.inboxDir")
  if ([version, state, main, inbox].every((value) => value === undefined)) return
  check(
    version === String(RECEIVER_VERSION) && state && main && inbox,
    "existing prs.git has incomplete or unsupported Yrd receiver configuration",
  )
  check(
    resolve(main) === receiver.mainRepo,
    `existing prs.git already belongs to main repository '${main}', not '${receiver.mainRepo}'`,
  )
  check(resolve(state) === receiver.stateDir, "existing prs.git is bound to another state directory")
  check(resolve(inbox) === receiver.inboxDir, "existing prs.git is bound to another receiver inbox")
}

async function text(path: string): Promise<string | undefined> {
  return (await entry(path)) ? readFile(path, "utf8") : undefined
}

async function preflightHooks(receiverPath: string, entry: string): Promise<void> {
  for (const mode of ["pre-receive", "post-receive"] as const) {
    const path = join(receiverPath, "hooks", mode)
    const body = await text(path)
    check(
      body === undefined || body === receiverHookSource(mode, entry) || body.startsWith(MANAGED_HOOK_PREFIX),
      `will not replace the unmanaged ${mode} hook at '${path}'`,
    )
  }
}

async function writeHook(receiverPath: string, mode: HookMode, entry: string): Promise<void> {
  const hooks = join(receiverPath, "hooks")
  const path = join(hooks, mode)
  const source = receiverHookSource(mode, entry)
  await mkdir(hooks, { recursive: true, mode: 0o700 })
  if ((await text(path)) === source) return chmod(path, 0o755)
  const temporary = await durableTemp(hooks, mode, source, 0o755)
  try {
    await rename(temporary, path)
    await syncDir(hooks)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function durableTemp(directory: string, name: string, body: string, mode: number): Promise<string> {
  const path = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`)
  const file = await open(path, "wx", mode)
  try {
    await file.writeFile(body, "utf8")
    await file.datasync()
  } finally {
    await file.close()
  }
  await chmod(path, mode)
  return path
}

async function syncDir(path: string): Promise<void> {
  const directory = await open(path, "r")
  try {
    await directory.sync()
  } catch (cause) {
    if (code(cause) !== "EINVAL" && code(cause) !== "ENOTSUP") throw cause
  } finally {
    await directory.close()
  }
}

function validSha(sha: string, length: number, label: string, zero = false): void {
  check(
    sha.length === length && HEX_SHA.test(sha) && (zero || !ZERO_SHA.test(sha)),
    `${label} must be a full ${length}-character${zero ? "" : " non-zero"} commit id`,
  )
}

function normalizeTarget(target: ReceiverTarget, receiver: GitPushReceiver): ReceiverTarget {
  const parsed = ReceiverTargetSchema.parse(target)
  validSha(parsed.baseSha, receiver.shaLength, "target baseSha")
  return parsed
}

async function refValue(receiver: GitPushReceiver, ref: string, env?: Environment): Promise<string | null> {
  const output = (await receiverGit(receiver, ["for-each-ref", "--format=%(refname)%00%(objectname)", ref], { env }))
    .stdout
  for (const entry of output.split("\n")) {
    const separator = entry.indexOf("\0")
    if (separator >= 0 && entry.slice(0, separator) === ref) return entry.slice(separator + 1)
  }
  return null
}

/**
 * Appends the caller-supplied intake policy to an authorization refusal. Both
 * refusal sites go through here so the sentence a seat is told can never drift
 * between the push-time check and the drain-time recheck.
 */
function withIntakePolicy(message: string, options: ReceiverHookOptions): string {
  return options.intakePolicy === undefined ? message : `${message}: ${options.intakePolicy}`
}

/**
 * Every `<base>/<change>` reading of a `refs/for/…` ref, longest base first.
 *
 * Both halves can contain slashes, so the split is genuinely ambiguous and the
 * ref alone cannot resolve it — `refs/for/main/@yrd/core/p2` reads four ways.
 * Gerrit disambiguates by taking the longest base that is an existing branch,
 * and so do we: this returns the candidates in that order and the caller,
 * which can reach a repository, picks the first that resolves.
 *
 * Empty on anything outside the namespace, and on a ref that names a base but
 * no change — `refs/for/main` is not a submit, it is a mistake, and it must be
 * refused rather than silently read as a branch push.
 */
export function submitRefSplits(ref: string): Array<{ base: string; name: string }> {
  if (!ref.startsWith(SUBMIT_PREFIX)) return []
  const rest = ref.slice(SUBMIT_PREFIX.length)
  const splits: Array<{ base: string; name: string }> = []
  for (let cut = rest.lastIndexOf("/"); cut > 0; cut = rest.lastIndexOf("/", cut - 1)) {
    splits.push({ base: rest.slice(0, cut), name: rest.slice(cut + 1) })
  }
  return splits
}

/**
 * Resolves a submit ref against the base branches that actually exist.
 *
 * Base existence is asked of the MAIN repository, which is where `validatePin`
 * already resolves `target.base` — one source of truth for "what is a base",
 * so a ref cannot be admitted against a base the pin check would then reject.
 */
async function submitIntent(receiver: GitPushReceiver, ref: string, env?: Environment): Promise<ReceiverSubmitIntent> {
  const splits = submitRefSplits(ref)
  check(
    splits.length > 0,
    `submit ref '${ref}' names no change; push to 'refs/for/<base>/<change>' where <change> is the issue reference`,
  )
  for (const split of splits) {
    const found = await mainGit(
      receiver.process,
      receiver.mainRepo,
      ["rev-parse", "--verify", `refs/heads/${split.base}^{commit}`],
      { env, allowFailure: true },
    )
    if (found.code === 0) return { base: split.base, name: split.name }
  }
  check(
    false,
    `submit ref '${ref}' names no base branch that exists; tried ${splits.map((split) => `'${split.base}'`).join(", ")}`,
  )
}

async function validBranch(receiver: GitPushReceiver, branch: string, label: string): Promise<void> {
  const result = await receiverGit(receiver, ["check-ref-format", "--branch", branch], { allowFailure: true })
  check(result.code === 0, `invalid ${label} '${branch}'`)
}

async function validatePin(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  target: ReceiverTarget,
  env?: Environment,
): Promise<void> {
  const current = await mainGit(
    receiver.process,
    receiver.mainRepo,
    ["rev-parse", "--verify", `refs/heads/${target.base}^{commit}`],
    {
      env,
      allowFailure: true,
    },
  )
  check(current.code === 0, `base branch '${target.base}' does not resolve in the main repository`)
  const pinned = await mainGit(
    receiver.process,
    receiver.mainRepo,
    ["merge-base", "--is-ancestor", target.baseSha, current.stdout],
    {
      env,
      allowFailure: true,
    },
  )
  check(
    pinned.code === 0,
    `pinned base ${target.baseSha.slice(0, 12)} is not in the history of base branch '${target.base}'`,
  )
  const descends = await receiverGit(receiver, ["merge-base", "--is-ancestor", target.baseSha, update.newSha], {
    env,
    allowFailure: true,
    includeMainObjects: true,
  })
  check(
    descends.code === 0,
    `pushed head ${update.newSha.slice(0, 12)} does not descend from pinned base ${target.baseSha.slice(0, 12)}`,
  )
}

async function validateSubmitCarrier(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  branch: string,
  env?: Environment,
): Promise<void> {
  const exact = `refs/heads/${branch}`
  const output = await mainGit(receiver.process, receiver.mainRepo, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
    exact,
  ])
  const current = output.stdout
    .split("\n")
    .map((line) => line.split("\0"))
    .find(([ref]) => ref === exact)?.[1]
  if (current === undefined) return
  const descends = await receiverGit(receiver, ["merge-base", "--is-ancestor", current, update.newSha], {
    env,
    allowFailure: true,
    includeMainObjects: true,
  })
  check(
    descends.code === 0,
    `carrier '${branch}' is at ${current.slice(0, 12)}, which the pushed head ` +
      `${update.newSha.slice(0, 12)} does not descend from; rebase the change onto it and push again`,
  )
}

/**
 * The pushed head's `.yrd.yml`, or undefined when that revision's tree has
 * none. `includeMainObjects` matters here exactly as it does for the ancestry
 * checks above: at pre-receive the pushed blob lives only in the receiver's
 * quarantine, not yet in the main repository's object store.
 */
async function readPushedBlob(
  receiver: GitPushReceiver,
  sha: string,
  path: string,
  env?: Environment,
): Promise<string | undefined> {
  const object = `${sha}:${path}`
  const exists = await receiverGit(receiver, ["cat-file", "-e", object], {
    env,
    allowFailure: true,
    includeMainObjects: true,
  })
  if (exists.code !== 0) return undefined
  return (await receiverGit(receiver, ["show", object], { env, includeMainObjects: true })).stdout
}

/**
 * Config admission: read the pushed head's `.yrd.yml` and hand it to whatever
 * schema the caller owns (@yrd/bay cannot import @yrd/cli's parser without a
 * dependency cycle — the receiver only ever reads the blob). Runs at BOTH
 * pre-receive and post-receive, same as `validatePin`/`validateSubmitCarrier`
 * above, so a config the base's own queue schema would refuse is rejected at
 * the push itself — the same "unlandable" guarantee those two already give
 * gitlink pins and carrier ancestry, closing the gap PR1337 fell through
 * (typecheck, lockfile and manifest gates all passed; nothing ever asked
 * whether the pushed .yrd.yml itself would parse).
 *
 * `options.validateConfig` is optional and additive: a caller that has not
 * wired a schema in yet keeps today's unjudged behavior exactly.
 */
async function validateQueueConfig(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  options: ReceiverHookOptions,
): Promise<void> {
  if (options.validateConfig === undefined) return
  await options.validateConfig(await readPushedBlob(receiver, update.newSha, ".yrd.yml", options.env))
}

async function authorize(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  options: ReceiverHookOptions,
  stage: "before" | "after",
): Promise<{ branch: string; target: ReceiverTarget; intent?: ReceiverSubmitIntent }> {
  validSha(update.oldSha, receiver.shaLength, "old commit id", true)
  validSha(update.newSha, receiver.shaLength, "new commit id", true)
  check(!ZERO_SHA.test(update.newSha), `ref deletion is not accepted for '${update.ref}'`)
  const isSubmit = update.ref.startsWith(SUBMIT_PREFIX)
  check(
    isSubmit || (update.ref.startsWith(BRANCH_PREFIX) && update.ref.length > BRANCH_PREFIX.length),
    `only branch refs under ${BRANCH_PREFIX} and submit refs under ${SUBMIT_PREFIX} are accepted, got '${update.ref}'`,
  )
  // A submit push predates its bay by construction, so it cannot be authorized
  // by "an active bay tracks this branch" — the ref carries the intent instead,
  // and the resolver's job becomes opening the bay rather than finding one.
  const intent = isSubmit ? await submitIntent(receiver, update.ref, options.env) : undefined
  const resolved = await options.resolveTarget(
    intent === undefined ? update.ref.slice(BRANCH_PREFIX.length) : intent.name,
    update,
    intent,
  )
  const subject =
    intent === undefined ? `branch '${update.ref.slice(BRANCH_PREFIX.length)}'` : `change '${intent.name}'`
  check(resolved, withIntakePolicy(`${subject} is not authorized for Yrd intake`, options))
  const branch = intent === undefined ? update.ref.slice(BRANCH_PREFIX.length) : resolved.branch
  check(
    branch !== undefined,
    `submit ref '${update.ref}' was admitted without a carrier branch; the resolver must name the branch the change lands on`,
  )
  await validBranch(receiver, branch, "intake branch")
  const target = normalizeTarget(resolved, receiver)
  await validBranch(receiver, target.base, "base branch")
  // The ref and the resolver must agree about where this lands. They are two
  // independent statements of the same fact, and a disagreement means the
  // change would gate against a base its author never named.
  check(
    intent === undefined || target.base === intent.base,
    `submit ref '${update.ref}' targets base '${intent?.base ?? ""}' but intake resolved base '${target.base}'`,
  )
  const current = await refValue(receiver, update.ref, options.env)
  const expected = stage === "after" ? update.newSha : ZERO_SHA.test(update.oldSha) ? null : update.oldSha
  check(
    current === expected,
    `stale ${stage === "before" ? "push" : "post-receive"} for '${update.ref}': expected ${expected ?? "no ref"}, found ${current ?? "no ref"}`,
  )
  await validatePin(receiver, update, target, options.env)
  if (intent !== undefined) await validateSubmitCarrier(receiver, update, branch, options.env)
  await validateQueueConfig(receiver, update, options)
  return intent === undefined ? { branch, target } : { branch, target, intent }
}

function resultId(update: ReceiverRefUpdate): string {
  return createHash("sha256").update(`${update.ref}\0${update.oldSha}\0${update.newSha}`).digest("hex")
}

function makeResult(
  update: ReceiverRefUpdate,
  authorized: { branch: string; target: ReceiverTarget; intent?: ReceiverSubmitIntent },
  clock: () => string,
): ReceiverResult {
  const { branch, target, intent } = authorized
  return {
    version: RESULT_VERSION,
    id: resultId(update),
    receivedAt: clock(),
    ref: update.ref,
    branch,
    ...(intent === undefined ? {} : { change: intent.name }),
    oldSha: update.oldSha,
    headSha: update.newSha,
    intake: {
      ...target,
      branch,
      headSha: update.newSha,
      ...(intent === undefined ? {} : { submit: true as const }),
    },
  }
}

function updateOf(result: ReceiverResult): ReceiverRefUpdate {
  return { oldSha: result.oldSha, newSha: result.headSha, ref: result.ref }
}

function resultPath(receiver: GitPushReceiver, state: ResultState, id: string): string {
  return join(receiver.inboxDir, `${id}.${state}.json`)
}

function sameResult(existing: ReceiverResult, expected: ReceiverResult, path: string): void {
  check(
    JSON.stringify({ ...existing, receivedAt: undefined }) === JSON.stringify({ ...expected, receivedAt: undefined }),
    `result collision at '${path}'`,
  )
}

async function linkResult(source: string, destination: string, result: ReceiverResult): Promise<boolean> {
  try {
    await link(source, destination)
    return true
  } catch (cause) {
    if (code(cause) !== "EEXIST") throw cause
    sameResult(await readResult(destination, result.id), result, destination)
    return false
  }
}

async function storeResult(
  receiver: GitPushReceiver,
  state: ResultState,
  result: ReceiverResult,
): Promise<{ path: string; created: boolean }> {
  const path = resultPath(receiver, state, result.id)
  if (await entry(path)) {
    sameResult(await readResult(path, result.id), result, path)
    return { path, created: false }
  }
  const temporary = await durableTemp(receiver.inboxDir, result.id, `${JSON.stringify(result)}\n`, 0o600)
  try {
    const created = await linkResult(temporary, path, result)
    if (created) await syncDir(receiver.inboxDir)
    return { path, created }
  } finally {
    await rm(temporary, { force: true })
  }
}

function validateResult(value: unknown, id: string, path: string): ReceiverResult {
  const parsed = ReceiverResultSchema.safeParse(value)
  check(parsed.success, `malformed result at '${path}'`)
  const result = parsed.data
  check(result.id === id, `malformed result at '${path}'`)
  check(
    resultId(updateOf(result)) === id && result.branch === result.intake.branch,
    `result identity mismatch at '${path}'`,
  )
  check(
    result.headSha === result.intake.headSha && resultRef(result) === result.ref,
    `result intake mismatch at '${path}'`,
  )
  return result
}

/**
 * The one ref a result's own contents could have come from.
 *
 * A branch push names its branch in the ref; a submit push names its base and
 * its change. Either way the ref is fully determined by fields the result
 * already carries, so this stays an equality — a result that cannot rebuild
 * its own ref is a result that has been edited.
 */
function resultRef(result: ReceiverResult): string {
  if (result.change === undefined) return `${BRANCH_PREFIX}${result.branch}`
  return `${SUBMIT_PREFIX}${result.intake.base}/${result.change}`
}

async function readResult(path: string, id: string): Promise<ReceiverResult> {
  try {
    return validateResult(JSON.parse(await readFile(path, "utf8")), id, path)
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw new Error(`yrd: receiver: invalid JSON in result '${path}': ${cause.message}`, { cause: cause })
    }
    throw cause
  }
}

async function moveResult(
  receiver: GitPushReceiver,
  result: ReceiverResult,
  from: ResultState,
  to: ResultState,
): Promise<void> {
  await linkResult(resultPath(receiver, from, result.id), resultPath(receiver, to, result.id), result)
  await rm(resultPath(receiver, from, result.id), { force: true })
  await syncDir(receiver.inboxDir)
}

async function validateStored(
  receiver: GitPushReceiver,
  result: ReceiverResult,
  options: ReceiverHookOptions,
): Promise<void> {
  validSha(result.oldSha, receiver.shaLength, "result old commit id", true)
  validSha(result.headSha, receiver.shaLength, "result head commit id")
  const update = updateOf(result)
  // The recheck must ask the SAME question the push asked. By now the bay a
  // submit opened exists, so a branch lookup would also answer — but only by
  // accident, and a resolver that answers only the intent would start failing
  // here for reasons that have nothing to do with authorization.
  const intent = result.change === undefined ? undefined : { base: result.intake.base, name: result.change }
  const resolved = await options.resolveTarget(result.branch, update, intent)
  check(resolved, withIntakePolicy(`branch '${result.branch}' is no longer authorized for Yrd intake`, options))
  const target = normalizeTarget(resolved, receiver)
  const stored = result.intake
  // Every field the result carries forward into intake is compared, including
  // the carrier branch: a submit resolver derives that branch rather than
  // reading it off the ref, so it is exactly the field that can move between
  // the push and the drain, and an unchecked field is an unauthorized one.
  check(
    stored.bay === target.bay &&
      stored.name === target.name &&
      stored.issue === target.issue &&
      stored.base === target.base &&
      stored.baseSha === target.baseSha &&
      stored.branch === (target.branch ?? result.branch),
    `authorization changed for result '${result.id}'`,
  )
  await validBranch(receiver, result.branch, "intake branch")
  await validBranch(receiver, result.intake.base, "base branch")
  await validatePin(receiver, update, target, options.env)
}

async function resultFiles(receiver: GitPushReceiver, state: ResultState): Promise<string[]> {
  const suffix = `.${state}.json`
  return (await readdir(receiver.inboxDir))
    .filter((name) => name.endsWith(suffix))
    .toSorted()
    .map((name) => join(receiver.inboxDir, name))
}

async function refContains(receiver: GitPushReceiver, ref: string, commit: string): Promise<boolean> {
  const current = await refValue(receiver, ref)
  if (current === null) return false
  if (current === commit) return true
  if (
    (await receiverGit(receiver, ["merge-base", "--is-ancestor", commit, current], { allowFailure: true })).code === 0
  ) {
    return true
  }
  const reflog = await receiverGit(receiver, ["reflog", "show", "--format=%H", ref], { allowFailure: true })
  return reflog.code === 0 && reflog.stdout.split("\n").includes(commit)
}

async function recoverPrepared(
  receiver: GitPushReceiver,
  options: ReceiverHookOptions,
  drain: ReceiverDrainResult,
): Promise<void> {
  for (const path of await resultFiles(receiver, "prepared")) {
    const id = basename(path).slice(0, -".prepared.json".length)
    try {
      const result = await readResult(path, id)
      if (!(await refContains(receiver, result.ref, result.headSha))) {
        drain.ambiguous.push(id)
        continue
      }
      await validateStored(receiver, result, options)
      await moveResult(receiver, result, "prepared", "pending")
    } catch (cause) {
      drain.failed.push({ id, error: message(cause) })
    }
  }
}

function resultOrder(left: StoredResult, right: StoredResult): number {
  return (
    left.result.receivedAt.localeCompare(right.result.receivedAt) || left.result.id.localeCompare(right.result.id)
  )
}

function orderBranch(results: StoredResult[]): StoredResult[] {
  const remaining = [...results].toSorted(resultOrder)
  const heads = new Set(results.map((item) => item.result.headSha))
  const ordered: StoredResult[] = []
  while (remaining.length > 0) {
    const root = remaining.findIndex((item) => !heads.has(item.result.oldSha))
    const [next] = remaining.splice(root < 0 ? 0 : root, 1)
    if (next === undefined) break
    ordered.push(next)
    heads.delete(next.result.headSha)
  }
  return ordered
}

async function pendingResults(receiver: GitPushReceiver, drain: ReceiverDrainResult): Promise<StoredResult[]> {
  const branches = new Map<string, StoredResult[]>()
  for (const path of await resultFiles(receiver, "pending")) {
    const id = basename(path).slice(0, -".pending.json".length)
    try {
      const result = await readResult(path, id)
      branches.set(result.branch, [...(branches.get(result.branch) ?? []), { path, result }])
    } catch (cause) {
      drain.failed.push({ id, error: message(cause) })
    }
  }
  return [...branches.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([, items]) => orderBranch(items))
}
