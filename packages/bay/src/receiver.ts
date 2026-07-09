import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { acquireWriterLock } from "@yrd/core"
import type { IntakeSubmissionArgs } from "./plugin.ts"

const RECEIVER_VERSION = 1 as const
const RECEIPT_VERSION = 1 as const
const MANAGED_HOOK_MARKER = "// yrd-managed-receiver-hook:1"
const ZERO_SHA = /^0+$/u
const HEX_SHA = /^[0-9a-f]+$/u
const REPOSITORY_ENV =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|COMMON_DIR|NAMESPACE|PREFIX|IMPLICIT_WORK_TREE)$/u

type Environment = Record<string, string | undefined>
type HookMode = "pre-receive" | "post-receive"
type InboxState = "prepared" | "pending" | "processing"

type ProcessResult = {
  code: number
  stdout: string
  stderr: string
}

export type ReceiverRefUpdate = {
  oldSha: string
  newSha: string
  ref: string
}

export type ReceiverTarget = {
  bay?: string
  name?: string
  base: string
  baseSha: string
}

export type ReceiverReceipt = {
  version: typeof RECEIPT_VERSION
  id: string
  receivedAt: string
  ref: string
  branch: string
  oldSha: string
  headSha: string
  intake: IntakeSubmissionArgs & { branch: string; base: string; baseSha: string }
}

export type GitPushReceiver = Readonly<{
  version: typeof RECEIVER_VERSION
  receiverPath: string
  mainRepo: string
  stateDir: string
  inboxDir: string
  objectFormat: "sha1" | "sha256"
  shaLength: 40 | 64
}>

export type ResolveReceiverTarget = (
  branch: string,
  update: Readonly<ReceiverRefUpdate>,
) => ReceiverTarget | null | undefined | Promise<ReceiverTarget | null | undefined>

/**
 * The implementation must atomically deduplicate `receipt.id` with its Bay
 * intake event. Drain recovery deliberately retries the same receipt after an
 * unknown callback outcome; a file-side acknowledgement cannot close that
 * cross-store crash window.
 */
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined
}

function cleanRepositoryEnv(source: Environment = process.env): Environment {
  const env: Environment = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !REPOSITORY_ENV.test(key)) env[key] = value
  }
  return env
}

async function run(argv: readonly string[], cwd: string, env: Environment): Promise<ProcessResult> {
  const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function command(
  argv: readonly string[],
  cwd: string,
  options: { env?: Environment; allowFailure?: boolean; label?: string } = {},
): Promise<ProcessResult> {
  const result = await run(argv, cwd, options.env ?? cleanRepositoryEnv())
  if (result.code !== 0 && options.allowFailure !== true) {
    const detail = result.stderr || result.stdout || `exit ${result.code}`
    throw new Error(`yrd: receiver: ${options.label ?? argv.join(" ")} failed: ${detail}`)
  }
  return result
}

async function mainGit(
  mainRepo: string,
  args: readonly string[],
  options: { allowFailure?: boolean; env?: Environment; label?: string } = {},
): Promise<ProcessResult> {
  return await command(["git", "-C", mainRepo, ...args], mainRepo, {
    ...options,
    env: cleanRepositoryEnv(options.env),
  })
}

async function receiverGit(
  receiver: Pick<GitPushReceiver, "receiverPath" | "mainRepo">,
  args: readonly string[],
  options: { allowFailure?: boolean; env?: Environment; label?: string; includeMainObjects?: boolean } = {},
): Promise<ProcessResult> {
  const env =
    options.includeMainObjects === true
      ? await receiverObjectEnv(receiver.mainRepo, options.env)
      : receiverHookEnv(options.env)
  return await command(["git", `--git-dir=${receiver.receiverPath}`, ...args], receiver.receiverPath, {
    ...options,
    env,
  })
}

function receiverHookEnv(source: Environment = process.env): Environment {
  const env: Environment = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (REPOSITORY_ENV.test(key) && key !== "GIT_OBJECT_DIRECTORY" && key !== "GIT_ALTERNATE_OBJECT_DIRECTORIES") {
      continue
    }
    env[key] = value
  }
  return env
}

function alternateEntry(path: string): string {
  return path.includes(delimiter) || path.includes('"') || path.includes("\\") ? JSON.stringify(path) : path
}

async function receiverObjectEnv(mainRepo: string, source: Environment = process.env): Promise<Environment> {
  const pathResult = await mainGit(mainRepo, ["rev-parse", "--git-path", "objects"], {
    env: source,
    label: "resolve main object directory",
  })
  const mainObjects = resolve(mainRepo, pathResult.stdout)
  const env: Environment = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (REPOSITORY_ENV.test(key) && key !== "GIT_OBJECT_DIRECTORY" && key !== "GIT_ALTERNATE_OBJECT_DIRECTORIES") {
      continue
    }
    env[key] = value
  }
  env.GIT_ALTERNATE_OBJECT_DIRECTORIES = [source.GIT_ALTERNATE_OBJECT_DIRECTORIES, alternateEntry(mainObjects)]
    .filter((value): value is string => value !== undefined && value !== "")
    .join(delimiter)
  return env
}

async function pathKind(path: string): Promise<"missing" | "directory" | "symlink" | "other"> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return "symlink"
    if (info.isDirectory()) return "directory"
    return "other"
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return "missing"
    throw cause
  }
}

function objectFormat(raw: string): { objectFormat: "sha1" | "sha256"; shaLength: 40 | 64 } {
  if (raw === "sha1") return { objectFormat: "sha1", shaLength: 40 }
  if (raw === "sha256") return { objectFormat: "sha256", shaLength: 64 }
  throw new Error(`yrd: receiver: unsupported Git object format '${raw}'`)
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (cause) {
    throw new Error(`yrd: receiver: cannot resolve ${label} '${path}': ${errorMessage(cause)}`)
  }
}

function receiverConfigArgs(config: GitPushReceiver): ReadonlyArray<readonly [string, string]> {
  return [
    ["yrd.receiverVersion", String(RECEIVER_VERSION)],
    ["yrd.stateDir", config.stateDir],
    ["yrd.mainRepo", config.mainRepo],
    ["yrd.inboxDir", config.inboxDir],
    ["receive.advertisePushOptions", "true"],
    ["receive.denyDeletes", "true"],
    ["receive.denyNonFastForwards", "false"],
    ["receive.fsckObjects", "true"],
    ["transfer.fsckObjects", "true"],
    ["core.logAllRefUpdates", "true"],
  ]
}

export function receiverHookSource(mode: HookMode): string {
  return [
    "#!/usr/bin/env bun",
    MANAGED_HOOK_MARKER,
    `const child = Bun.spawn(["yrd", "receiver-hook", "${mode}"], {`,
    '  stdin: "inherit",',
    '  stdout: "inherit",',
    '  stderr: "inherit",',
    "  env: process.env,",
    "})",
    "process.exit(await child.exited)",
    "",
  ].join("\n")
}

async function preflightHooks(receiverPath: string): Promise<void> {
  for (const mode of ["pre-receive", "post-receive"] as const) {
    const path = join(receiverPath, "hooks", mode)
    if (!existsSync(path)) continue
    const body = await readFile(path, "utf8")
    if (body !== receiverHookSource(mode) && !body.startsWith("#!/usr/bin/env bun\n// yrd-managed-receiver-hook:")) {
      throw new Error(`yrd: receiver: refusing to replace unmanaged ${mode} hook at '${path}'`)
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r")
  try {
    await directory.sync()
  } catch (cause) {
    if (errorCode(cause) !== "EINVAL" && errorCode(cause) !== "ENOTSUP") throw cause
  } finally {
    await directory.close()
  }
}

async function writeManagedHook(receiverPath: string, mode: HookMode): Promise<void> {
  const hooksDir = join(receiverPath, "hooks")
  const path = join(hooksDir, mode)
  const source = receiverHookSource(mode)
  await mkdir(hooksDir, { recursive: true, mode: 0o700 })
  if (existsSync(path) && (await readFile(path, "utf8")) === source) {
    await chmod(path, 0o755)
    return
  }
  const temporary = join(hooksDir, `.${mode}.${process.pid}.${randomUUID()}.tmp`)
  const file = await open(temporary, "wx", 0o755)
  try {
    await file.writeFile(source, "utf8")
    await file.datasync()
  } finally {
    await file.close()
  }
  try {
    await chmod(temporary, 0o755)
    await rename(temporary, path)
    await syncDirectory(hooksDir)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function ensureInboxLayout(inboxDir: string): Promise<void> {
  await mkdir(inboxDir, { recursive: true, mode: 0o700 })
  await Promise.all(
    (["prepared", "pending", "processing"] as const).map((state) =>
      mkdir(join(inboxDir, state), { recursive: true, mode: 0o700 }),
    ),
  )
}

async function readConfig(receiverPath: string, key: string): Promise<string> {
  const result = await command(["git", `--git-dir=${receiverPath}`, "config", "--local", "--get", key], receiverPath, {
    env: cleanRepositoryEnv(),
    allowFailure: true,
    label: `read ${key}`,
  })
  if (result.code !== 0 || result.stdout === "") {
    throw new Error(`yrd: receiver: '${receiverPath}' is missing required config '${key}'`)
  }
  return result.stdout
}

async function optionalConfig(receiverPath: string, key: string): Promise<string | undefined> {
  const result = await command(["git", `--git-dir=${receiverPath}`, "config", "--local", "--get", key], receiverPath, {
    env: cleanRepositoryEnv(),
    allowFailure: true,
    label: `read ${key}`,
  })
  if (result.code === 1 && result.stdout === "") return undefined
  if (result.code !== 0) throw new Error(`yrd: receiver: cannot read config '${key}': ${result.stderr || result.stdout}`)
  return result.stdout
}

async function validateExistingBinding(receiver: GitPushReceiver): Promise<void> {
  const keys = ["yrd.receiverVersion", "yrd.stateDir", "yrd.mainRepo", "yrd.inboxDir"] as const
  const values = new Map<string, string | undefined>()
  for (const key of keys) values.set(key, await optionalConfig(receiver.receiverPath, key))
  if ([...values.values()].every((value) => value === undefined)) return
  if (values.get("yrd.receiverVersion") !== String(RECEIVER_VERSION)) {
    throw new Error(`yrd: receiver: existing prs.git has incomplete or unsupported Yrd receiver configuration`)
  }
  const configuredMain = values.get("yrd.mainRepo")
  const configuredState = values.get("yrd.stateDir")
  const configuredInbox = values.get("yrd.inboxDir")
  if (configuredMain === undefined || resolve(configuredMain) !== receiver.mainRepo) {
    throw new Error(
      `yrd: receiver: existing prs.git already belongs to main repository '${configuredMain ?? "unknown"}', not '${receiver.mainRepo}'`,
    )
  }
  if (configuredState === undefined || resolve(configuredState) !== receiver.stateDir) {
    throw new Error(`yrd: receiver: existing prs.git is bound to another state directory`)
  }
  if (configuredInbox === undefined || resolve(configuredInbox) !== receiver.inboxDir) {
    throw new Error(`yrd: receiver: existing prs.git is bound to another receiver inbox`)
  }
}

async function validateBareRepository(receiverPath: string): Promise<{ objectFormat: "sha1" | "sha256"; shaLength: 40 | 64 }> {
  const bare = await command(["git", `--git-dir=${receiverPath}`, "rev-parse", "--is-bare-repository"], receiverPath, {
    env: cleanRepositoryEnv(),
    allowFailure: true,
    label: "validate prs.git",
  })
  if (bare.code !== 0 || bare.stdout !== "true") {
    throw new Error(`yrd: receiver: '${receiverPath}' exists but is not a bare Git repository`)
  }
  const format = await command(["git", `--git-dir=${receiverPath}`, "rev-parse", "--show-object-format"], receiverPath, {
    env: cleanRepositoryEnv(),
    label: "read receiver object format",
  })
  return objectFormat(format.stdout)
}

export async function createGitPushReceiver(options: {
  mainRepo: string
  stateDir: string
  receiverPath?: string
  inboxDir?: string
}): Promise<GitPushReceiver> {
  const requestedMain = resolve(options.mainRepo)
  const requestedState = resolve(options.stateDir)
  await mkdir(requestedState, { recursive: true, mode: 0o700 })
  const mainRepo = await canonicalDirectory(requestedMain, "main repository")
  const stateDir = await canonicalDirectory(requestedState, "receiver state directory")
  const receiverPath = resolve(options.receiverPath ?? join(stateDir, "prs.git"))
  const inboxDir = resolve(options.inboxDir ?? join(stateDir, "receiver-inbox"))

  const mainFormatResult = await mainGit(mainRepo, ["rev-parse", "--show-object-format"], {
    label: "read main repository object format",
  })
  const expectedFormat = objectFormat(mainFormatResult.stdout)
  const initLock = await acquireWriterLock(join(stateDir, "receiver-init"), { timeoutMs: 30_000, pollIntervalMs: 10 })
  try {
    const kind = await pathKind(receiverPath)
    if (kind === "symlink") throw new Error(`yrd: receiver: refusing symlinked prs.git at '${receiverPath}'`)
    if (kind === "other") throw new Error(`yrd: receiver: '${receiverPath}' exists and is not a directory`)
    if (kind === "missing") {
      await mkdir(dirname(receiverPath), { recursive: true, mode: 0o700 })
      await mkdir(receiverPath, { mode: 0o700 })
      try {
        await command(
          ["git", "init", "--bare", "--initial-branch=main", `--object-format=${expectedFormat.objectFormat}`, receiverPath],
          dirname(receiverPath),
          { env: cleanRepositoryEnv(), label: "initialize prs.git" },
        )
      } catch (cause) {
        throw new Error(
          `yrd: receiver: prs.git initialization failed; partial directory preserved at '${receiverPath}': ${errorMessage(cause)}`,
        )
      }
    }

    const receiverFormat = await validateBareRepository(receiverPath)
    if (receiverFormat.objectFormat !== expectedFormat.objectFormat) {
      throw new Error(
        `yrd: receiver: object format mismatch: main uses ${expectedFormat.objectFormat}, prs.git uses ${receiverFormat.objectFormat}`,
      )
    }

    const receiver: GitPushReceiver = Object.freeze({
      version: RECEIVER_VERSION,
      receiverPath,
      mainRepo,
      stateDir,
      inboxDir,
      ...receiverFormat,
    })
    await validateExistingBinding(receiver)
    await preflightHooks(receiverPath)
    await ensureInboxLayout(inboxDir)
    for (const [key, value] of receiverConfigArgs(receiver)) {
      await receiverGit(receiver, ["config", "--local", key, value], { label: `configure ${key}` })
    }

    const branches = await mainGit(mainRepo, ["for-each-ref", "--format=%(refname)", "refs/heads"], {
      label: "list base branches",
    })
    if (branches.stdout !== "") {
      await receiverGit(
        receiver,
        ["fetch", "--quiet", "--no-tags", mainRepo, "+refs/heads/*:refs/yrd/bases/*"],
        { label: "mirror base branches" },
      )
    }
    await writeManagedHook(receiverPath, "pre-receive")
    await writeManagedHook(receiverPath, "post-receive")
    return receiver
  } finally {
    await initLock.release()
  }
}

export async function loadGitPushReceiver(path: string): Promise<GitPushReceiver> {
  const receiverPath = resolve(path)
  const kind = await pathKind(receiverPath)
  if (kind !== "directory") throw new Error(`yrd: receiver: prs.git is not a real directory at '${receiverPath}'`)
  const format = await validateBareRepository(receiverPath)
  const version = await readConfig(receiverPath, "yrd.receiverVersion")
  if (version !== String(RECEIVER_VERSION)) {
    throw new Error(`yrd: receiver: unsupported receiver version '${version}' at '${receiverPath}'`)
  }
  const [mainRepo, stateDir, inboxDir] = await Promise.all([
    readConfig(receiverPath, "yrd.mainRepo"),
    readConfig(receiverPath, "yrd.stateDir"),
    readConfig(receiverPath, "yrd.inboxDir"),
  ])
  const receiver: GitPushReceiver = Object.freeze({
    version: RECEIVER_VERSION,
    receiverPath,
    mainRepo: resolve(mainRepo),
    stateDir: resolve(stateDir),
    inboxDir: resolve(inboxDir),
    ...format,
  })
  await ensureInboxLayout(receiver.inboxDir)
  return receiver
}

export function parseReceiverUpdates(input: string): ReceiverRefUpdate[] {
  const updates: ReceiverRefUpdate[] = []
  const refs = new Set<string>()
  for (const raw of input.split("\n")) {
    const line = raw.trim()
    if (line === "") continue
    const parts = line.split(/\s+/u)
    if (parts.length !== 3) throw new Error(`yrd: receiver: malformed receive line '${line}'`)
    const [oldSha, newSha, ref] = parts as [string, string, string]
    if (!HEX_SHA.test(oldSha) || !HEX_SHA.test(newSha)) {
      throw new Error(`yrd: receiver: malformed commit id in receive line '${line}'`)
    }
    if (refs.has(ref)) throw new Error(`yrd: receiver: duplicate update for '${ref}'`)
    refs.add(ref)
    updates.push({ oldSha, newSha, ref })
  }
  return updates
}

function branchOf(ref: string): string {
  const prefix = "refs/heads/"
  if (!ref.startsWith(prefix) || ref.length === prefix.length) {
    throw new Error(`yrd: receiver: only branch refs under refs/heads/ are accepted, got '${ref}'`)
  }
  return ref.slice(prefix.length)
}

function validateSha(sha: string, length: number, label: string, allowZero: boolean): void {
  if (sha.length !== length || !HEX_SHA.test(sha) || (!allowZero && ZERO_SHA.test(sha))) {
    throw new Error(`yrd: receiver: ${label} must be a full ${length}-character non-zero commit id`)
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`yrd: receiver: ${label} must not be empty`)
  return value
}

function normalizeTarget(target: ReceiverTarget, receiver: GitPushReceiver): ReceiverTarget {
  const normalized: ReceiverTarget = {
    base: nonEmpty(target.base, "target base"),
    baseSha: nonEmpty(target.baseSha, "target baseSha"),
    ...(target.bay === undefined ? {} : { bay: nonEmpty(target.bay, "target bay") }),
    ...(target.name === undefined ? {} : { name: nonEmpty(target.name, "target name") }),
  }
  validateSha(normalized.baseSha, receiver.shaLength, "target baseSha", false)
  return normalized
}

function receiptId(update: ReceiverRefUpdate): string {
  return createHash("sha256").update(`${update.ref}\0${update.oldSha}\0${update.newSha}`, "utf8").digest("hex")
}

function updateOf(receipt: ReceiverReceipt): ReceiverRefUpdate {
  return { oldSha: receipt.oldSha, newSha: receipt.headSha, ref: receipt.ref }
}

function targetOf(receipt: ReceiverReceipt): ReceiverTarget {
  return {
    ...(receipt.intake.bay === undefined ? {} : { bay: receipt.intake.bay }),
    ...(receipt.intake.name === undefined ? {} : { name: receipt.intake.name }),
    base: receipt.intake.base,
    baseSha: receipt.intake.baseSha,
  }
}

function sameTarget(left: ReceiverTarget, right: ReceiverTarget): boolean {
  return left.bay === right.bay && left.name === right.name && left.base === right.base && left.baseSha === right.baseSha
}

async function refValue(receiver: GitPushReceiver, ref: string, env?: Environment): Promise<string | null> {
  const result = await receiverGit(receiver, ["for-each-ref", "--format=%(refname)%00%(objectname)", ref], {
    env,
    label: `resolve ${ref}`,
  })
  for (const line of result.stdout.split("\n")) {
    const separator = line.indexOf("\0")
    if (separator !== -1 && line.slice(0, separator) === ref) return line.slice(separator + 1)
  }
  return null
}

async function validateBranchName(receiver: GitPushReceiver, branch: string, label: string): Promise<void> {
  const result = await receiverGit(receiver, ["check-ref-format", "--branch", branch], {
    allowFailure: true,
    label: `validate ${label}`,
  })
  if (result.code !== 0) throw new Error(`yrd: receiver: invalid ${label} '${branch}'`)
}

async function validatePinnedObjects(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  target: ReceiverTarget,
  env?: Environment,
): Promise<void> {
  const head = await receiverGit(receiver, ["cat-file", "-e", `${update.newSha}^{commit}`], {
    env,
    allowFailure: true,
    includeMainObjects: true,
    label: "validate pushed commit",
  })
  if (head.code !== 0) throw new Error(`yrd: receiver: pushed head ${update.newSha} is not a commit in prs.git`)

  const base = await mainGit(receiver.mainRepo, ["cat-file", "-e", `${target.baseSha}^{commit}`], {
    env,
    allowFailure: true,
    label: "validate pinned base",
  })
  if (base.code !== 0) {
    throw new Error(`yrd: receiver: pinned base ${target.baseSha} is not a commit in the main repository`)
  }
  const baseRef = `refs/heads/${target.base}`
  const currentBase = await mainGit(receiver.mainRepo, ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    env,
    allowFailure: true,
    label: "resolve base branch",
  })
  if (currentBase.code !== 0) {
    throw new Error(`yrd: receiver: base branch '${target.base}' does not resolve in the main repository`)
  }
  const baseLineage = await mainGit(
    receiver.mainRepo,
    ["merge-base", "--is-ancestor", target.baseSha, currentBase.stdout],
    { env, allowFailure: true, label: "validate base branch pin" },
  )
  if (baseLineage.code === 1) {
    throw new Error(
      `yrd: receiver: pinned base ${target.baseSha.slice(0, 12)} is not in the history of base branch '${target.base}'`,
    )
  }
  if (baseLineage.code !== 0) {
    throw new Error(`yrd: receiver: cannot validate base branch pin: ${baseLineage.stderr || baseLineage.stdout}`)
  }

  const ancestor = await receiverGit(receiver, ["merge-base", "--is-ancestor", target.baseSha, update.newSha], {
    env,
    allowFailure: true,
    includeMainObjects: true,
    label: "validate pinned ancestry",
  })
  if (ancestor.code === 1) {
    throw new Error(
      `yrd: receiver: pushed head ${update.newSha.slice(0, 12)} does not descend from pinned base ${target.baseSha.slice(0, 12)}`,
    )
  }
  if (ancestor.code !== 0) {
    throw new Error(`yrd: receiver: cannot validate pinned ancestry: ${ancestor.stderr || ancestor.stdout}`)
  }
}

async function authorizeUpdate(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  options: ReceiverHookOptions,
  stage: "before" | "after",
): Promise<{ branch: string; target: ReceiverTarget }> {
  if (update.oldSha.length !== receiver.shaLength || update.newSha.length !== receiver.shaLength) {
    throw new Error(`yrd: receiver: receive ids must match the repository's ${receiver.objectFormat} object format`)
  }
  validateSha(update.oldSha, receiver.shaLength, "old commit id", true)
  validateSha(update.newSha, receiver.shaLength, "new commit id", true)
  if (ZERO_SHA.test(update.newSha)) throw new Error(`yrd: receiver: ref deletion is not accepted for '${update.ref}'`)

  const branch = branchOf(update.ref)
  await validateBranchName(receiver, branch, "intake branch")
  const resolved = await options.resolveTarget(branch, update)
  if (resolved === null || resolved === undefined) {
    throw new Error(`yrd: receiver: branch '${branch}' is not authorized for Yrd intake`)
  }
  const target = normalizeTarget(resolved, receiver)
  await validateBranchName(receiver, target.base, "base branch")

  const current = await refValue(receiver, update.ref, options.env)
  const expected = stage === "before" ? (ZERO_SHA.test(update.oldSha) ? null : update.oldSha) : update.newSha
  if (current !== expected) {
    throw new Error(
      `yrd: receiver: stale ${stage === "before" ? "push" : "post-receive"} for '${update.ref}': expected ${expected ?? "no ref"}, found ${current ?? "no ref"}`,
    )
  }
  await validatePinnedObjects(receiver, update, target, options.env)
  return { branch, target }
}

function buildReceipt(
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
    intake: {
      ...(target.bay === undefined ? {} : { bay: target.bay }),
      ...(target.name === undefined ? {} : { name: target.name }),
      branch,
      base: target.base,
      baseSha: target.baseSha,
      headSha: update.newSha,
    },
  }
}

function inboxPath(receiver: GitPushReceiver, state: InboxState, id: string): string {
  return join(receiver.inboxDir, state, `${id}.json`)
}

function receiptComparable(receipt: ReceiverReceipt): string {
  return JSON.stringify({ ...receipt, receivedAt: undefined })
}

function assertSameReceipt(existing: ReceiverReceipt, expected: ReceiverReceipt, path: string): void {
  if (receiptComparable(existing) !== receiptComparable(expected)) {
    throw new Error(`yrd: receiver: receipt collision at '${path}'`)
  }
}

async function writeReceiptExclusive(
  receiver: GitPushReceiver,
  state: InboxState,
  receipt: ReceiverReceipt,
): Promise<{ path: string; created: boolean }> {
  const dir = join(receiver.inboxDir, state)
  const path = inboxPath(receiver, state, receipt.id)
  if (existsSync(path)) {
    assertSameReceipt(await readReceipt(path, receipt.id), receipt, path)
    return { path, created: false }
  }

  const temporary = join(dir, `.${receipt.id}.${process.pid}.${randomUUID()}.tmp`)
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(`${JSON.stringify(receipt)}\n`, "utf8")
    await file.datasync()
  } finally {
    await file.close()
  }
  try {
    await link(temporary, path)
    await syncDirectory(dir)
    return { path, created: true }
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") throw cause
    assertSameReceipt(await readReceipt(path, receipt.id), receipt, path)
    return { path, created: false }
  } finally {
    await rm(temporary, { force: true })
  }
}

function assertReceipt(value: unknown, expectedId: string, path: string): ReceiverReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`yrd: receiver: malformed receipt at '${path}'`)
  }
  const receipt = value as Partial<ReceiverReceipt>
  if (
    receipt.version !== RECEIPT_VERSION ||
    receipt.id !== expectedId ||
    typeof receipt.receivedAt !== "string" ||
    typeof receipt.ref !== "string" ||
    typeof receipt.branch !== "string" ||
    typeof receipt.oldSha !== "string" ||
    typeof receipt.headSha !== "string" ||
    typeof receipt.intake !== "object" ||
    receipt.intake === null ||
    typeof receipt.intake.branch !== "string" ||
    typeof receipt.intake.base !== "string" ||
    typeof receipt.intake.baseSha !== "string" ||
    typeof receipt.intake.headSha !== "string"
  ) {
    throw new Error(`yrd: receiver: malformed receipt at '${path}'`)
  }
  const complete = receipt as ReceiverReceipt
  if (receiptId(updateOf(complete)) !== expectedId || complete.branch !== complete.intake.branch) {
    throw new Error(`yrd: receiver: receipt identity mismatch at '${path}'`)
  }
  if (complete.headSha !== complete.intake.headSha || complete.ref !== `refs/heads/${complete.branch}`) {
    throw new Error(`yrd: receiver: receipt intake mismatch at '${path}'`)
  }
  return complete
}

async function readReceipt(path: string, expectedId: string): Promise<ReceiverReceipt> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, "utf8"))
  } catch (cause) {
    throw new Error(`yrd: receiver: invalid JSON in receipt '${path}': ${errorMessage(cause)}`)
  }
  return assertReceipt(value, expectedId, path)
}

async function moveReceipt(
  receiver: GitPushReceiver,
  receipt: ReceiverReceipt,
  from: InboxState,
  to: InboxState,
): Promise<string> {
  const source = inboxPath(receiver, from, receipt.id)
  const destination = inboxPath(receiver, to, receipt.id)
  if (existsSync(destination)) {
    assertSameReceipt(await readReceipt(destination, receipt.id), receipt, destination)
    await rm(source, { force: true })
    await syncDirectory(dirname(source))
    return destination
  }
  try {
    await link(source, destination)
    await syncDirectory(dirname(destination))
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") throw cause
    assertSameReceipt(await readReceipt(destination, receipt.id), receipt, destination)
  }
  await unlink(source)
  await syncDirectory(dirname(source))
  return destination
}

export async function prepareReceiverUpdates(
  receiver: GitPushReceiver,
  input: string | readonly ReceiverRefUpdate[],
  options: ReceiverHookOptions,
): Promise<ReceiverReceipt[]> {
  const updates = typeof input === "string" ? parseReceiverUpdates(input) : [...input]
  const clock = options.clock ?? (() => new Date().toISOString())
  const created: string[] = []
  const receipts: ReceiverReceipt[] = []
  try {
    for (const update of updates) {
      const authorized = await authorizeUpdate(receiver, update, options, "before")
      const receipt = buildReceipt(update, authorized.branch, authorized.target, clock)
      const written = await writeReceiptExclusive(receiver, "prepared", receipt)
      if (written.created) created.push(written.path)
      receipts.push(receipt)
    }
    return receipts
  } catch (cause) {
    await Promise.all(
      created.map(async (path) => {
        await rm(path, { force: true })
        await syncDirectory(dirname(path))
      }),
    )
    throw cause
  }
}

async function validateStoredReceipt(
  receiver: GitPushReceiver,
  receipt: ReceiverReceipt,
  options: ReceiverHookOptions,
): Promise<void> {
  validateSha(receipt.oldSha, receiver.shaLength, "receipt old commit id", true)
  validateSha(receipt.headSha, receiver.shaLength, "receipt head commit id", false)
  const update = updateOf(receipt)
  const resolved = await options.resolveTarget(receipt.branch, update)
  if (resolved === null || resolved === undefined) {
    throw new Error(`yrd: receiver: branch '${receipt.branch}' is no longer authorized for Yrd intake`)
  }
  const currentTarget = normalizeTarget(resolved, receiver)
  if (!sameTarget(targetOf(receipt), currentTarget)) {
    throw new Error(`yrd: receiver: authorization changed for receipt '${receipt.id}'`)
  }
  await validateBranchName(receiver, receipt.branch, "intake branch")
  await validateBranchName(receiver, receipt.intake.base, "base branch")
  await validatePinnedObjects(receiver, update, currentTarget, options.env)
}

export async function finalizeReceiverUpdates(
  receiver: GitPushReceiver,
  input: string | readonly ReceiverRefUpdate[],
  options: ReceiverHookOptions,
): Promise<ReceiverReceipt[]> {
  const updates = typeof input === "string" ? parseReceiverUpdates(input) : [...input]
  const clock = options.clock ?? (() => new Date().toISOString())
  const receipts: ReceiverReceipt[] = []
  for (const update of updates) {
    const id = receiptId(update)
    const preparedPath = inboxPath(receiver, "prepared", id)
    let receipt: ReceiverReceipt
    if (existsSync(preparedPath)) {
      receipt = await readReceipt(preparedPath, id)
      const stored = updateOf(receipt)
      if (stored.oldSha !== update.oldSha || stored.newSha !== update.newSha || stored.ref !== update.ref) {
        throw new Error(`yrd: receiver: prepared receipt '${id}' does not match post-receive input`)
      }
      const current = await refValue(receiver, update.ref, options.env)
      if (current !== update.newSha) {
        throw new Error(`yrd: receiver: post-receive ref '${update.ref}' is ${current ?? "missing"}, expected ${update.newSha}`)
      }
      await validateStoredReceipt(receiver, receipt, options)
    } else {
      const authorized = await authorizeUpdate(receiver, update, options, "after")
      receipt = buildReceipt(update, authorized.branch, authorized.target, clock)
      await writeReceiptExclusive(receiver, "prepared", receipt)
    }
    await moveReceipt(receiver, receipt, "prepared", "pending")
    receipts.push(receipt)
  }
  if (options.intake !== undefined) await drainReceiverInbox(receiver, options as ReceiverHookOptions & { intake: DurableReceiverIntake })
  return receipts
}

async function receiptFiles(receiver: GitPushReceiver, state: InboxState): Promise<string[]> {
  const dir = join(receiver.inboxDir, state)
  return (await readdir(dir))
    .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
    .sort()
    .map((name) => join(dir, name))
}

function idFromPath(path: string): string {
  const name = basename(path)
  return name.endsWith(".json") ? name.slice(0, -5) : name
}

async function refContains(receiver: GitPushReceiver, ref: string, commit: string): Promise<boolean> {
  const current = await refValue(receiver, ref)
  if (current === null) return false
  if (current === commit) return true
  const ancestor = await receiverGit(receiver, ["merge-base", "--is-ancestor", commit, current], {
    allowFailure: true,
    label: `reconcile ${ref}`,
  })
  if (ancestor.code === 0) return true
  const reflog = await receiverGit(receiver, ["reflog", "show", "--format=%H", ref], {
    allowFailure: true,
    label: `read ${ref} reflog`,
  })
  return reflog.code === 0 && reflog.stdout.split("\n").includes(commit)
}

async function recoverPrepared(
  receiver: GitPushReceiver,
  options: ReceiverHookOptions,
  result: ReceiverDrainResult,
): Promise<void> {
  for (const path of await receiptFiles(receiver, "prepared")) {
    const id = idFromPath(path)
    try {
      const receipt = await readReceipt(path, id)
      if (!(await refContains(receiver, receipt.ref, receipt.headSha))) {
        result.ambiguous.push(id)
        continue
      }
      await validateStoredReceipt(receiver, receipt, options)
      await moveReceipt(receiver, receipt, "prepared", "pending")
    } catch (cause) {
      result.failed.push({ id, error: errorMessage(cause) })
    }
  }
}

async function processReceipt(
  receiver: GitPushReceiver,
  path: string,
  options: ReceiverHookOptions & { intake: DurableReceiverIntake },
  result: ReceiverDrainResult,
  blockedBranches: Set<string>,
): Promise<void> {
  const id = idFromPath(path)
  let receipt: ReceiverReceipt
  try {
    receipt = await readReceipt(path, id)
  } catch (cause) {
    result.failed.push({ id, error: errorMessage(cause) })
    return
  }
  if (blockedBranches.has(receipt.branch)) {
    result.failed.push({ id, error: `blocked by an earlier failed receipt for branch '${receipt.branch}'` })
    return
  }
  try {
    await validateStoredReceipt(receiver, receipt, options)
    await options.intake(receipt)
    await unlink(path)
    await syncDirectory(dirname(path))
    result.delivered.push(id)
  } catch (cause) {
    blockedBranches.add(receipt.branch)
    result.failed.push({ id, error: errorMessage(cause) })
  }
}

type QueuedReceipt = { path: string; receipt: ReceiverReceipt }

function receiptFallbackOrder(left: QueuedReceipt, right: QueuedReceipt): number {
  return left.receipt.receivedAt.localeCompare(right.receipt.receivedAt) || left.receipt.id.localeCompare(right.receipt.id)
}

function orderBranchReceipts(receipts: QueuedReceipt[]): QueuedReceipt[] {
  const byHead = new Map(receipts.map((item) => [item.receipt.headSha, item]))
  const children = new Map<string, QueuedReceipt[]>()
  const roots: QueuedReceipt[] = []
  for (const item of receipts) {
    const parent = byHead.get(item.receipt.oldSha)
    if (parent === undefined || parent === item) {
      roots.push(item)
      continue
    }
    const entries = children.get(parent.receipt.id) ?? []
    entries.push(item)
    children.set(parent.receipt.id, entries)
  }
  roots.sort(receiptFallbackOrder)
  for (const entries of children.values()) entries.sort(receiptFallbackOrder)

  const ordered: QueuedReceipt[] = []
  const visited = new Set<string>()
  const visit = (item: QueuedReceipt): void => {
    if (visited.has(item.receipt.id)) return
    visited.add(item.receipt.id)
    ordered.push(item)
    for (const child of children.get(item.receipt.id) ?? []) visit(child)
  }
  for (const root of roots) visit(root)
  for (const item of [...receipts].sort(receiptFallbackOrder)) visit(item)
  return ordered
}

async function orderedProcessingReceipts(
  receiver: GitPushReceiver,
  result: ReceiverDrainResult,
): Promise<QueuedReceipt[]> {
  const groups = new Map<string, QueuedReceipt[]>()
  for (const path of await receiptFiles(receiver, "processing")) {
    const id = idFromPath(path)
    try {
      const receipt = await readReceipt(path, id)
      const group = groups.get(receipt.branch) ?? []
      group.push({ path, receipt })
      groups.set(receipt.branch, group)
    } catch (cause) {
      result.failed.push({ id, error: errorMessage(cause) })
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, receipts]) => orderBranchReceipts(receipts))
}

export async function drainReceiverInbox(
  receiver: GitPushReceiver,
  options: ReceiverHookOptions & { intake: DurableReceiverIntake; lockTimeoutMs?: number },
): Promise<ReceiverDrainResult> {
  await ensureInboxLayout(receiver.inboxDir)
  const result: ReceiverDrainResult = { delivered: [], failed: [], ambiguous: [] }
  const lock = await acquireWriterLock(join(receiver.inboxDir, "drain-lock"), {
    timeoutMs: options.lockTimeoutMs ?? 0,
    pollIntervalMs: 10,
  })
  try {
    await recoverPrepared(receiver, options, result)
    const blockedBranches = new Set<string>()
    for (const pendingPath of await receiptFiles(receiver, "pending")) {
      const id = idFromPath(pendingPath)
      const processingPath = inboxPath(receiver, "processing", id)
      let receipt: ReceiverReceipt
      try {
        receipt = await readReceipt(pendingPath, id)
        await moveReceipt(receiver, receipt, "pending", "processing")
      } catch (cause) {
        result.failed.push({ id, error: errorMessage(cause) })
        continue
      }
      if (!existsSync(processingPath)) {
        result.failed.push({ id, error: `receipt claim disappeared at '${processingPath}'` })
      }
    }
    for (const queued of await orderedProcessingReceipts(receiver, result)) {
      await processReceipt(receiver, queued.path, options, result, blockedBranches)
    }
    return result
  } finally {
    await lock.release()
  }
}

async function hookInput(): Promise<string> {
  return await Bun.stdin.text()
}

function receiverPathFromHookEnvironment(env: Environment, cwd: string): string {
  const gitDir = env.GIT_DIR
  if (gitDir === undefined || gitDir === "") {
    throw new Error("yrd: receiver: GIT_DIR is missing in receive-hook environment")
  }
  return resolve(cwd, gitDir)
}

export async function runReceiverHookFromEnvironment(
  mode: HookMode,
  options: ReceiverHookOptions & { input?: string },
): Promise<ReceiverReceipt[]> {
  const env = options.env ?? process.env
  const receiver = await loadGitPushReceiver(receiverPathFromHookEnvironment(env, process.cwd()))
  const input = options.input ?? (await hookInput())
  if (mode === "pre-receive") return await prepareReceiverUpdates(receiver, input, { ...options, env })
  if (mode === "post-receive") return await finalizeReceiverUpdates(receiver, input, { ...options, env })
  throw new Error(`yrd: receiver: unsupported hook mode '${String(mode)}'`)
}
