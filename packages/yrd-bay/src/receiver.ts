import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { createExclusive } from "@yrd/persistence"
import type { Process } from "@yrd/process"
import * as z from "zod"
import { GitRefSchema, GitShaSchema } from "./model.ts"

const RECEIVER_VERSION = 1 as const
const RECEIPT_VERSION = 1 as const
const MANAGED_HOOK_MARKER = "// yrd-managed-receiver-hook:1"
const MANAGED_HOOK_PREFIX = "#!/usr/bin/env bun\n// yrd-managed-receiver-hook:"
const ZERO_SHA = /^0+$/u
const HEX_SHA = /^[0-9a-f]+$/u
const REPOSITORY_ENV =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|COMMON_DIR|NAMESPACE|PREFIX|IMPLICIT_WORK_TREE)$/u

type Environment = Record<string, string | undefined>
type HookMode = "pre-receive" | "post-receive"
type ReceiptState = "prepared" | "pending"

const TextSchema = z.string().trim().min(1)
const ReceiverRefUpdateSchema = z
  .object({ oldSha: z.string().regex(HEX_SHA), newSha: z.string().regex(HEX_SHA), ref: TextSchema })
  .strict()
const ReceiverTargetSchema = z
  .object({ bay: TextSchema.optional(), name: TextSchema.optional(), base: GitRefSchema, baseSha: GitShaSchema })
  .strict()
const ReceiverReceiptSchema = z
  .object({
    version: z.literal(RECEIPT_VERSION),
    id: z.string().regex(/^[0-9a-f]{64}$/u),
    receivedAt: z.iso.datetime({ offset: true }),
    ref: TextSchema,
    branch: GitRefSchema,
    oldSha: GitShaSchema,
    headSha: GitShaSchema,
    intake: ReceiverTargetSchema.extend({ branch: GitRefSchema, headSha: GitShaSchema }).strict(),
  })
  .strict()

export type ReceiverRefUpdate = z.infer<typeof ReceiverRefUpdateSchema>
export type ReceiverTarget = z.infer<typeof ReceiverTargetSchema>
export type ReceiverReceipt = z.infer<typeof ReceiverReceiptSchema>
export type GitPushReceiver = Readonly<{
  version: typeof RECEIVER_VERSION
  receiverPath: string
  mainRepo: string
  stateDir: string
  inboxDir: string
  objectFormat: "sha1" | "sha256"
  shaLength: 40 | 64
  process: Pick<Process, "run">
  prepare(input: string | readonly ReceiverRefUpdate[], options: ReceiverHookOptions): Promise<ReceiverReceipt[]>
  finalize(input: string | readonly ReceiverRefUpdate[], options: ReceiverHookOptions): Promise<ReceiverReceipt[]>
  drain(
    options: ReceiverHookOptions & { intake: DurableReceiverIntake; lockTimeoutMs?: number },
  ): Promise<ReceiverDrainResult>
}>
export type ResolveReceiverTarget = (
  branch: string,
  update: Readonly<ReceiverRefUpdate>,
) => ReceiverTarget | null | undefined | Promise<ReceiverTarget | null | undefined>

/** Intake must atomically deduplicate receipt.id with its own durable event. */
export type DurableReceiverIntake = (receipt: Readonly<ReceiverReceipt>) => void | Promise<void>
export type ReceiverHookOptions = {
  resolveTarget: ResolveReceiverTarget
  intake?: DurableReceiverIntake
  clock?: () => string
  env?: Environment
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
    check(!current?.isSymbolicLink(), `refusing symlinked prs.git at '${receiverPath}'`)
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
): Promise<ReceiverReceipt[]> {
  const clock = options.clock ?? (() => new Date().toISOString())
  const created: string[] = []
  const receipts: ReceiverReceipt[] = []
  try {
    for (const value of typeof input === "string" ? parseReceiverUpdates(input) : input) {
      const update = ReceiverRefUpdateSchema.parse(value)
      const { branch, target } = await authorize(receiver, update, options, "before")
      const receipt = makeReceipt(update, branch, target, clock)
      const stored = await storeReceipt(receiver, "prepared", receipt)
      if (stored.created) created.push(stored.path)
      receipts.push(receipt)
    }
    return receipts
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
): Promise<ReceiverReceipt[]> {
  const clock = options.clock ?? (() => new Date().toISOString())
  const receipts: ReceiverReceipt[] = []
  for (const value of typeof input === "string" ? parseReceiverUpdates(input) : input) {
    const update = ReceiverRefUpdateSchema.parse(value)
    const id = receiptId(update)
    const path = receiptPath(receiver, "prepared", id)
    let receipt: ReceiverReceipt
    if (await entry(path)) {
      receipt = await readReceipt(path, id)
      const stored = updateOf(receipt)
      check(
        stored.oldSha === update.oldSha && stored.newSha === update.newSha && stored.ref === update.ref,
        `prepared receipt '${id}' does not match post-receive input`,
      )
      const current = await refValue(receiver, update.ref, options.env)
      check(
        current === update.newSha,
        `post-receive ref '${update.ref}' is ${current ?? "missing"}, expected ${update.newSha}`,
      )
      await validateStored(receiver, receipt, options)
    } else {
      const authorized = await authorize(receiver, update, options, "after")
      receipt = makeReceipt(update, authorized.branch, authorized.target, clock)
      await storeReceipt(receiver, "prepared", receipt)
    }
    await moveReceipt(receiver, receipt, "prepared", "pending")
    receipts.push(receipt)
  }
  if (options.intake) await receiver.drain({ ...options, intake: options.intake })
  return receipts
}

async function drainReceiverInbox(
  receiver: GitPushReceiver,
  options: ReceiverHookOptions & { intake: DurableReceiverIntake; lockTimeoutMs?: number },
): Promise<ReceiverDrainResult> {
  await mkdir(receiver.inboxDir, { recursive: true, mode: 0o700 })
  const result: ReceiverDrainResult = { delivered: [], failed: [], ambiguous: [] }
  const exclusive = createExclusive(join(receiver.inboxDir, "drain-lock"), {
    timeoutMs: options.lockTimeoutMs ?? 0,
    pollIntervalMs: 10,
  })
  return exclusive.run(async () => {
    await recoverPrepared(receiver, options, result)
    const blocked = new Set<string>()
    for (const { path, receipt } of await pendingReceipts(receiver, result)) {
      if (blocked.has(receipt.branch)) {
        result.failed.push({
          id: receipt.id,
          error: `blocked by an earlier failed receipt for branch '${receipt.branch}'`,
        })
        continue
      }
      try {
        await validateStored(receiver, receipt, options)
        await options.intake(receipt)
        await rm(path)
        await syncDir(receiver.inboxDir)
        result.delivered.push(receipt.id)
      } catch (cause) {
        blocked.add(receipt.branch)
        result.failed.push({ id: receipt.id, error: message(cause) })
      }
    }
    return result
  })
}

export async function runReceiverHookFromEnvironment(
  mode: HookMode,
  options: ReceiverHookOptions & { input?: string; process: Pick<Process, "run"> },
): Promise<ReceiverReceipt[]> {
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
type StoredReceipt = { path: string; receipt: ReceiverReceipt }

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
  const completed = await process.run({ argv, cwd, env: options.env ?? gitEnv() })
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
      `refusing to replace unmanaged ${mode} hook at '${path}'`,
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

async function authorize(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  options: ReceiverHookOptions,
  stage: "before" | "after",
): Promise<{ branch: string; target: ReceiverTarget }> {
  validSha(update.oldSha, receiver.shaLength, "old commit id", true)
  validSha(update.newSha, receiver.shaLength, "new commit id", true)
  check(!ZERO_SHA.test(update.newSha), `ref deletion is not accepted for '${update.ref}'`)
  check(
    update.ref.startsWith("refs/heads/") && update.ref.length > 11,
    `only branch refs under refs/heads/ are accepted, got '${update.ref}'`,
  )
  const branch = update.ref.slice(11)
  await validBranch(receiver, branch, "intake branch")
  const resolved = await options.resolveTarget(branch, update)
  check(resolved, `branch '${branch}' is not authorized for Yrd intake`)
  const target = normalizeTarget(resolved, receiver)
  await validBranch(receiver, target.base, "base branch")
  const current = await refValue(receiver, update.ref, options.env)
  const expected = stage === "after" ? update.newSha : ZERO_SHA.test(update.oldSha) ? null : update.oldSha
  check(
    current === expected,
    `stale ${stage === "before" ? "push" : "post-receive"} for '${update.ref}': expected ${expected ?? "no ref"}, found ${current ?? "no ref"}`,
  )
  await validatePin(receiver, update, target, options.env)
  return { branch, target }
}

function receiptId(update: ReceiverRefUpdate): string {
  return createHash("sha256").update(`${update.ref}\0${update.oldSha}\0${update.newSha}`).digest("hex")
}

function makeReceipt(
  update: ReceiverRefUpdate,
  branch: string,
  target: ReceiverTarget,
  clock: () => string,
): ReceiverReceipt {
  return {
    version: RECEIPT_VERSION,
    id: receiptId(update),
    receivedAt: clock(),
    ref: update.ref,
    branch,
    oldSha: update.oldSha,
    headSha: update.newSha,
    intake: { ...target, branch, headSha: update.newSha },
  }
}

function updateOf(receipt: ReceiverReceipt): ReceiverRefUpdate {
  return { oldSha: receipt.oldSha, newSha: receipt.headSha, ref: receipt.ref }
}

function receiptPath(receiver: GitPushReceiver, state: ReceiptState, id: string): string {
  return join(receiver.inboxDir, `${id}.${state}.json`)
}

function sameReceipt(existing: ReceiverReceipt, expected: ReceiverReceipt, path: string): void {
  check(
    JSON.stringify({ ...existing, receivedAt: undefined }) === JSON.stringify({ ...expected, receivedAt: undefined }),
    `receipt collision at '${path}'`,
  )
}

async function linkReceipt(source: string, destination: string, receipt: ReceiverReceipt): Promise<boolean> {
  try {
    await link(source, destination)
    return true
  } catch (cause) {
    if (code(cause) !== "EEXIST") throw cause
    sameReceipt(await readReceipt(destination, receipt.id), receipt, destination)
    return false
  }
}

async function storeReceipt(
  receiver: GitPushReceiver,
  state: ReceiptState,
  receipt: ReceiverReceipt,
): Promise<{ path: string; created: boolean }> {
  const path = receiptPath(receiver, state, receipt.id)
  if (await entry(path)) {
    sameReceipt(await readReceipt(path, receipt.id), receipt, path)
    return { path, created: false }
  }
  const temporary = await durableTemp(receiver.inboxDir, receipt.id, `${JSON.stringify(receipt)}\n`, 0o600)
  try {
    const created = await linkReceipt(temporary, path, receipt)
    if (created) await syncDir(receiver.inboxDir)
    return { path, created }
  } finally {
    await rm(temporary, { force: true })
  }
}

function validateReceipt(value: unknown, id: string, path: string): ReceiverReceipt {
  const parsed = ReceiverReceiptSchema.safeParse(value)
  check(parsed.success, `malformed receipt at '${path}'`)
  const receipt = parsed.data
  check(receipt.id === id, `malformed receipt at '${path}'`)
  check(
    receiptId(updateOf(receipt)) === id && receipt.branch === receipt.intake.branch,
    `receipt identity mismatch at '${path}'`,
  )
  check(
    receipt.headSha === receipt.intake.headSha && receipt.ref === `refs/heads/${receipt.branch}`,
    `receipt intake mismatch at '${path}'`,
  )
  return receipt
}

async function readReceipt(path: string, id: string): Promise<ReceiverReceipt> {
  try {
    return validateReceipt(JSON.parse(await readFile(path, "utf8")), id, path)
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw new Error(`yrd: receiver: invalid JSON in receipt '${path}': ${cause.message}`, { cause: cause })
    }
    throw cause
  }
}

async function moveReceipt(
  receiver: GitPushReceiver,
  receipt: ReceiverReceipt,
  from: ReceiptState,
  to: ReceiptState,
): Promise<void> {
  await linkReceipt(receiptPath(receiver, from, receipt.id), receiptPath(receiver, to, receipt.id), receipt)
  await rm(receiptPath(receiver, from, receipt.id), { force: true })
  await syncDir(receiver.inboxDir)
}

async function validateStored(
  receiver: GitPushReceiver,
  receipt: ReceiverReceipt,
  options: ReceiverHookOptions,
): Promise<void> {
  validSha(receipt.oldSha, receiver.shaLength, "receipt old commit id", true)
  validSha(receipt.headSha, receiver.shaLength, "receipt head commit id")
  const update = updateOf(receipt)
  const resolved = await options.resolveTarget(receipt.branch, update)
  check(resolved, `branch '${receipt.branch}' is no longer authorized for Yrd intake`)
  const target = normalizeTarget(resolved, receiver)
  const stored = receipt.intake
  check(
    stored.bay === target.bay &&
      stored.name === target.name &&
      stored.base === target.base &&
      stored.baseSha === target.baseSha,
    `authorization changed for receipt '${receipt.id}'`,
  )
  await validBranch(receiver, receipt.branch, "intake branch")
  await validBranch(receiver, receipt.intake.base, "base branch")
  await validatePin(receiver, update, target, options.env)
}

async function receiptFiles(receiver: GitPushReceiver, state: ReceiptState): Promise<string[]> {
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
  result: ReceiverDrainResult,
): Promise<void> {
  for (const path of await receiptFiles(receiver, "prepared")) {
    const id = basename(path).slice(0, -".prepared.json".length)
    try {
      const receipt = await readReceipt(path, id)
      if (!(await refContains(receiver, receipt.ref, receipt.headSha))) {
        result.ambiguous.push(id)
        continue
      }
      await validateStored(receiver, receipt, options)
      await moveReceipt(receiver, receipt, "prepared", "pending")
    } catch (cause) {
      result.failed.push({ id, error: message(cause) })
    }
  }
}

function receiptOrder(left: StoredReceipt, right: StoredReceipt): number {
  return (
    left.receipt.receivedAt.localeCompare(right.receipt.receivedAt) || left.receipt.id.localeCompare(right.receipt.id)
  )
}

function orderBranch(receipts: StoredReceipt[]): StoredReceipt[] {
  const remaining = [...receipts].toSorted(receiptOrder)
  const heads = new Set(receipts.map((item) => item.receipt.headSha))
  const ordered: StoredReceipt[] = []
  while (remaining.length > 0) {
    const root = remaining.findIndex((item) => !heads.has(item.receipt.oldSha))
    const [next] = remaining.splice(root < 0 ? 0 : root, 1)
    if (next === undefined) break
    ordered.push(next)
    heads.delete(next.receipt.headSha)
  }
  return ordered
}

async function pendingReceipts(receiver: GitPushReceiver, result: ReceiverDrainResult): Promise<StoredReceipt[]> {
  const branches = new Map<string, StoredReceipt[]>()
  for (const path of await receiptFiles(receiver, "pending")) {
    const id = basename(path).slice(0, -".pending.json".length)
    try {
      const receipt = await readReceipt(path, id)
      branches.set(receipt.branch, [...(branches.get(receipt.branch) ?? []), { path, receipt }])
    } catch (cause) {
      result.failed.push({ id, error: message(cause) })
    }
  }
  return [...branches.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([, items]) => orderBranch(items))
}
