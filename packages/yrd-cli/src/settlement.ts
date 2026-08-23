import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, opendirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ChangePropsSchema, normalizeV1CorrelationToProps } from "@yrd/bay"
import { parseJournalFrame, type Journal } from "@yrd/core"
import { createExclusive, createReadOnlyJournal } from "@yrd/persistence"
import { discoverYrdRepository, type YrdRepository } from "./repository.ts"
import { formatDuration } from "./runner-timeline.ts"

/**
 * Background settlement of terminal delivery facts.
 *
 * Yrd commits terminal change facts and carries opaque props; it has no idea what
 * a prop MEANS to the host that stamped it. This module owns the half that is
 * Yrd's: read the journal forward from a durable cursor, find the terminal
 * facts that carry a prop, hand them to whoever asked to be
 * told, and advance the cursor only once they have all been acknowledged. The
 * host supplies the other half — what "settled" does — through a hook module it
 * names in {@link YRD_SETTLEMENT_HOOK_ENV}.
 *
 * The work happens in a DETACHED child so a command's exit is never held open
 * by it, and its failures are written down rather than printed into a command's
 * output: a background failure that only ever reached a terminated process's
 * stderr is a silent error. The next command in the same repository drains
 * those notices and prints them.
 */

export const YRD_SETTLEMENT_HOOK_ENV = "YRD_SETTLEMENT_HOOK" as const
export const YRD_SETTLEMENT_STATE_ENV = "YRD_SETTLEMENT_STATE" as const
export const YRD_SETTLEMENT_CWD_ENV = "YRD_SETTLEMENT_CWD" as const
export const YRD_SETTLEMENT_REPOSITORY_NAME_ENV = "YRD_SETTLEMENT_REPOSITORY_NAME" as const
export const YRD_SETTLEMENT_PARENT_PID_ENV = "YRD_SETTLEMENT_PARENT_PID" as const
export const YRD_SETTLEMENT_RESIDENT_ENV = "YRD_SETTLEMENT_RESIDENT" as const
export const YRD_SETTLEMENT_NOTICE_PATH_ENV = "YRD_SETTLEMENT_NOTICE_PATH" as const

/** Internal argv that runs one settlement worker in an already-launched Yrd. */
export const YRD_SETTLEMENT_COMMAND = "_settle" as const

const DEFAULT_STATE_SEGMENTS = Object.freeze(["settlements"])
const TERMINAL_EVENT_NAMES: ReadonlySet<string> = new Set([
  "pr/integrated",
  "pr/rejected",
  "pr/withdrawn",
  "pr/canceled",
])
const HABITANT_ACTIVATION_MS = 1_000
const HABITANT_TICK_MS = 15_000
const BUSY_RETRIES = 50
const NOTICE_SCAN_CAP = 100

export type YrdSettlementTarget = Readonly<{ key: string; value: string; eventId: string }>

/**
 * The host's half of settlement.
 *
 * `owner` is opaque to Yrd and only ever used to keep one cursor per settler:
 * two hosts draining the same journal must not consume each other's progress.
 * A hook with no owner observes without settling, which is what a cursor that
 * records observation only is for.
 */
export type YrdSettlementHook = Readonly<{
  /** Prop key this hook settles; every other key is left untouched. */
  key: string
  owner?: string
  settle(targets: readonly YrdSettlementTarget[]): Promise<void>
  /** Called once per batch that contained an integration, after its cursor advances. */
  integrated?(context: Readonly<{ repository: YrdRepository; repositoryName?: string }>): Promise<void>
  close?(): Promise<void> | void
}>

export type YrdSettlementHookContext = Readonly<{
  env: Readonly<Record<string, string | undefined>>
  repository: YrdRepository
  repositoryName?: string
}>

/** The one export a settlement hook module must provide. */
export type YrdSettlementHookFactory = (
  context: YrdSettlementHookContext,
) => Promise<YrdSettlementHook | undefined> | YrdSettlementHook | undefined

export const YRD_SETTLEMENT_HOOK_EXPORT = "createYrdSettlementHook" as const

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms)
  })
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`yrd: ${name} is missing`)
  return value
}

function takeRequiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = requiredEnv(env, name)
  delete env[name]
  return value
}

/**
 * Where settlement state lives under a repository's Yrd state directory.
 *
 * A host that already has settlement cursors on disk names their location so a
 * cutover does not silently rewind to the start of the journal and re-settle
 * every historical props.
 */
export function settlementStateSegments(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const declared = env[YRD_SETTLEMENT_STATE_ENV]?.trim()
  if (declared === undefined || declared === "") return DEFAULT_STATE_SEGMENTS
  const segments = declared.split("/")
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes("\\")) {
      throw new Error(
        `yrd: ${YRD_SETTLEMENT_STATE_ENV} must be a relative path of plain segments; got ${JSON.stringify(declared)}`,
      )
    }
  }
  return Object.freeze(segments)
}

export function settlementStateDir(repository: Pick<YrdRepository, "stateDir">, segments: readonly string[]): string {
  return join(repository.stateDir, ...segments)
}

export function settlementNoticeDir(gitDir: string, segments: readonly string[]): string {
  return join(gitDir, "yrd", ...segments, "notices")
}

function ownerKey(owner: string | undefined): string {
  return owner === undefined ? "ownerless" : Buffer.from(owner, "utf8").toString("base64url")
}

export function settlementCursorPath(dir: string, owner: string | undefined): string {
  return owner === undefined ? join(dir, "ownerless-v2.json") : join(dir, "cursors-v2", `${ownerKey(owner)}.json`)
}

function settlementErrorPath(dir: string, owner: string | undefined): string {
  return join(dir, "errors-v1", `${ownerKey(owner)}.json`)
}

function shellQuote(value: string): string {
  const quote = String.fromCharCode(39)
  return `${quote}${value.replaceAll(quote, `${quote}\\${quote}${quote}`)}${quote}`
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}

export type SettlementCursorRead = Readonly<{
  /**
   * Retention floor from the journal. Required in the missing-cursor refusal so
   * the operator can choose an explicit restart without the loader inventing one.
   * Omit only when the journal has no history diagnostics; the refusal then
   * names that unreadability instead of substituting 0.
   */
  evictedThrough?: number
}>

/** Every refusal about a cursor carries the command that repairs it: a cursor
 * this reader cannot use is unreadable to every future command too, so a
 * refusal without the remedy is a permanently stuck rail. */
function cursorRecovery(path: string, evictedThrough: number | undefined): string {
  const floor =
    evictedThrough === undefined ? "unreadable (journal has no history diagnostics)" : String(evictedThrough)
  return (
    `recovery: re-initialize ${shellQuote(path)} with an explicit cursor ` +
    `(floor evictedThrough=${floor}); do not move the cursor file aside — ` +
    `absence is not a position`
  )
}

export async function readSettlementCursor(
  path: string,
  owner: string | undefined,
  options: SettlementCursorRead = {},
): Promise<number> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    const record = value as Record<string, unknown> | null
    if (
      typeof value !== "object" ||
      record === null ||
      Array.isArray(value) ||
      record["version"] !== 2 ||
      record["owner"] !== (owner ?? null) ||
      !Number.isSafeInteger(record["cursor"]) ||
      (record["cursor"] as number) < 0
    ) {
      throw new Error(
        `expected { version: 2, owner: ${JSON.stringify(owner ?? null)}, cursor: non-negative-safe-integer }`,
      )
    }
    return record["cursor"] as number
  } catch (error) {
    if (isEnoent(error)) {
      const floor =
        options.evictedThrough === undefined
          ? "unreadable (journal has no history diagnostics)"
          : String(options.evictedThrough)
      throw new Error(
        `yrd: settlement cursor is missing (${path}) for owner ${JSON.stringify(owner ?? null)}; ` +
          `evictedThrough ${floor} — the range below the floor cannot be settled by anyone; ` +
          `${cursorRecovery(path, options.evictedThrough)}`,
        { cause: error },
      )
    }
    throw new Error(
      `yrd: settlement cursor is invalid (${path}): ${detail(error)}; ${cursorRecovery(path, options.evictedThrough)}`,
      { cause: error },
    )
  }
}

/** Replace-by-rename so a cursor is never observed half-written; a reader that
 * saw a truncated cursor would settle a range twice or skip one entirely. */
async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function writeSettlementCursor(path: string, owner: string | undefined, cursor: number): Promise<void> {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error(`yrd: invalid settlement cursor ${cursor}`)
  await writeJsonAtomically(path, { version: 2, owner: owner ?? null, cursor })
}

/**
 * Create a worker's cursor. Creating the worker is the act that establishes
 * its position; the loader never infers one from a missing file.
 *
 * The destination is created exclusively (`wx`) so a second create cannot
 * skip ahead of a live position. Advances after registration go through
 * {@link writeSettlementCursor}.
 */
export async function registerSettlementCursor(path: string, owner: string | undefined, cursor: number): Promise<void> {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error(`yrd: invalid settlement cursor ${cursor}`)
  await mkdir(dirname(path), { recursive: true })
  const body = `${JSON.stringify({ version: 2, owner: owner ?? null, cursor })}\n`
  try {
    await writeFile(path, body, { flag: "wx" })
  } catch (error) {
    if (isEexist(error)) {
      throw new Error(
        `yrd: settlement cursor already registered (${path}) for owner ${JSON.stringify(owner ?? null)}; ` +
          `absence is the only registration window — do not overwrite a live position`,
        { cause: error },
      )
    }
    throw error
  }
}

/**
 * Worker create: write the floor cursor if this owner has never registered,
 * leave a live cursor untouched. `evictedThrough` is the journal's own floor,
 * not a default the loader invented from absence.
 */
export async function registerSettlementWorker(options: {
  stateDir: string
  owner: string | undefined
  evictedThrough: number
}): Promise<void> {
  const path = settlementCursorPath(options.stateDir, options.owner)
  try {
    await registerSettlementCursor(path, options.owner, options.evictedThrough)
  } catch (error) {
    if (!detail(error).includes("already registered")) throw error
  }
}

/**
 * The terminal facts in one batch that a prop key asked to be told about.
 *
 * `integrated` is reported separately from the settlements because an
 * integration is a fact about the repository, not about any one prop:
 * a batch can integrate without carrying a single prop this hook owns.
 */
export function terminalSettlementTargets(
  values: readonly unknown[],
  key: string,
): Readonly<{ targets: readonly YrdSettlementTarget[]; integrated: boolean }> {
  const targets: YrdSettlementTarget[] = []
  const seen = new Set<string>()
  let integrated = false
  for (const value of values) {
    const frame = parseJournalFrame(value)
    for (const applied of frame.events) {
      if (applied.name === "pr/integrated") integrated = true
      if (!TERMINAL_EVENT_NAMES.has(applied.name)) continue
      const data = applied.data as Record<string, unknown> | null
      // Pre-props journals spell the payload `correlation: {namespace, id}`;
      // the fold turns it into a one-entry props map before the schema reads it.
      const folded = typeof data === "object" && data !== null ? normalizeV1CorrelationToProps(data) : null
      const propsValue =
        typeof folded === "object" && folded !== null ? (folded as Record<string, unknown>)["props"] : undefined
      if (propsValue === undefined) continue
      const props = ChangePropsSchema.parse(propsValue)
      const value_ = props[key]
      if (value_ === undefined) continue
      const dedup = `${encodeURIComponent(key)}=${encodeURIComponent(value_)}:${applied.id}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      targets.push(Object.freeze({ key, value: value_, eventId: applied.id }))
    }
  }
  return Object.freeze({ targets: Object.freeze(targets), integrated })
}

export type SettlementDrainOptions = Readonly<{
  repository: YrdRepository
  hook: YrdSettlementHook
  stateDir: string
  repositoryName?: string
  /** Seam for tests; production opens the repository's own read-only journal. */
  journal?: Journal<unknown>
}>

/**
 * Settle every terminal fact this hook owns, then advance its cursor.
 *
 * The cursor advances per batch and only AFTER `settle` resolved for that
 * batch, so a settler that throws leaves the range unconsumed and the next
 * drain retries it. That ordering is the whole correctness argument: the
 * alternative — advance first, settle after — loses a settlement to any crash
 * and there is no second source to recover it from.
 */
export async function settleCommittedTerminals(options: SettlementDrainOptions): Promise<void> {
  const { hook, repository } = options
  const cursorPath = settlementCursorPath(options.stateDir, hook.owner)
  const journal = options.journal ?? createReadOnlyJournal({ dir: repository.stateDir })
  const evictedThrough = journal.history?.diagnostics().evictedThrough
  const cursor = await readSettlementCursor(cursorPath, hook.owner, (evictedThrough === undefined ? {} : { evictedThrough }))
  try {
    for await (const batch of journal.read(cursor)) {
      const { targets, integrated } = terminalSettlementTargets(batch.values, hook.key)
      if (hook.owner !== undefined && targets.length > 0) await hook.settle(targets)
      // Owner cursors advance only after every terminal has an acknowledgement.
      // The ownerless cursor records observation only.
      await writeSettlementCursor(cursorPath, hook.owner, batch.cursor)
      if (integrated) {
        await hook.integrated?.({
          repository,
          ...(options.repositoryName === undefined ? {} : { repositoryName: options.repositoryName }),
        })
      }
    }
  } catch (error) {
    const message = detail(error)
    if (error instanceof RangeError && message.startsWith("yrd: journal range ")) {
      throw new RangeError(`${message}; ${cursorRecovery(cursorPath, evictedThrough)}`, { cause: error })
    }
    throw error
  }
}

function exclusiveBusy(error: unknown): boolean {
  return detail(error).includes("writer lock is busy")
}

/**
 * One exclusive settlement pass, returning its failure rather than throwing.
 *
 * A drain runs beside a command whose result it must not change, so every
 * failure becomes a value: written to a per-owner error file for the next drain
 * and returned for the caller to record as an operator-visible notice.
 */
export async function drainSettlements(
  options: SettlementDrainOptions & Readonly<{ retries: number }>,
): Promise<unknown> {
  const errorPath = settlementErrorPath(options.stateDir, options.hook.owner)
  const exclusive = createExclusive(options.stateDir, { timeoutMs: 0 })
  let error: unknown
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await exclusive.run(async () => {
        try {
          await settleCommittedTerminals(options)
          await rm(errorPath, { force: true })
          return undefined
        } catch (cause) {
          await writeJsonAtomically(errorPath, {
            version: 1,
            owner: options.hook.owner ?? null,
            workerPid: process.pid,
            failedAt: new Date().toISOString(),
            error: detail(cause),
          })
          return cause
        }
      })
    } catch (cause) {
      error = cause
      if (!exclusiveBusy(cause) || attempt === options.retries) break
      await sleep(100)
    }
  }
  return error
}

async function loadSettlementHook(
  specifier: string,
  context: YrdSettlementHookContext,
): Promise<YrdSettlementHook | undefined> {
  let module: Record<string, unknown>
  try {
    module = (await import(specifier)) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `yrd: cannot load the settlement hook named by ${YRD_SETTLEMENT_HOOK_ENV} (${specifier}): ${detail(error)}`,
      { cause: error },
    )
  }
  const factory = module[YRD_SETTLEMENT_HOOK_EXPORT]
  if (typeof factory !== "function") {
    throw new Error(
      `yrd: settlement hook ${specifier} must export ${YRD_SETTLEMENT_HOOK_EXPORT}; ` +
        `${YRD_SETTLEMENT_HOOK_ENV} names the module that settles Yrd's terminal facts`,
    )
  }
  const hook = await (factory as YrdSettlementHookFactory)(context)
  if (hook === undefined) return undefined
  if (typeof hook.key !== "string" || hook.key.trim() === "") {
    throw new Error(`yrd: settlement hook ${specifier} returned no prop key`)
  }
  // A blank owner is a host bug, and the quiet reading of it — "ownerless, so
  // observe but never settle" — looks exactly like a healthy drain while every
  // terminal fact goes unacknowledged.
  if (hook.owner?.trim() === "") {
    throw new Error(`yrd: settlement hook ${specifier} returned a blank owner; omit the owner to observe only`)
  }
  return hook
}

export type SettlementWorkerIO = Readonly<{ stderr: (text: string) => void }>

/**
 * The detached worker: one drain for an ordinary command, a supervised loop for
 * a habitant runner.
 *
 * The habitant's lifetime is the PARENT's, observed through an inherited pipe
 * on fd 3 rather than by polling a pid — a pid can be reused, an inherited pipe
 * cannot. A parent that exits before the worker is even useful (the activation
 * window) means the command was over before settlement mattered, so the worker
 * makes one final pass and stops.
 */
export async function runYrdSettlementWorker(
  env: Record<string, string | undefined>,
  io: SettlementWorkerIO,
): Promise<void> {
  const commandCwd = takeRequiredEnv(env, YRD_SETTLEMENT_CWD_ENV)
  const repositoryName = env[YRD_SETTLEMENT_REPOSITORY_NAME_ENV]?.trim()
  delete env[YRD_SETTLEMENT_REPOSITORY_NAME_ENV]
  const parentPid = Number(takeRequiredEnv(env, YRD_SETTLEMENT_PARENT_PID_ENV))
  const habitant = (env[YRD_SETTLEMENT_RESIDENT_ENV] ?? "0") === "1"
  delete env[YRD_SETTLEMENT_RESIDENT_ENV]
  const noticePath = takeRequiredEnv(env, YRD_SETTLEMENT_NOTICE_PATH_ENV)
  const specifier = takeRequiredEnv(env, YRD_SETTLEMENT_HOOK_ENV)
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) throw new Error("yrd: settlement parent pid is invalid")
  const segments = settlementStateSegments(env)

  let lastReportedError: string | undefined
  const report = async (error: unknown, owner: string | undefined): Promise<void> => {
    if (error === undefined) {
      lastReportedError = undefined
      return
    }
    const message = detail(error)
    try {
      await writeJsonAtomically(noticePath, {
        version: 1,
        owner: owner ?? null,
        commandCwd,
        parentPid,
        workerPid: process.pid,
        failedAt: new Date().toISOString(),
        error: message,
      })
    } catch (noticeError) {
      io.stderr(
        `warning: Yrd could not save a background failure for the next command (${detail(noticeError)}); ` +
          `original failure: ${message}\n`,
      )
    }
    if (message === lastReportedError) return
    lastReportedError = message
    io.stderr(`warning: Yrd background work failed; command result unaffected: ${message}\n`)
  }

  let hook: YrdSettlementHook | undefined
  try {
    const repository = await discoverYrdRepository({ cwd: commandCwd })
    const named = repositoryName === undefined || repositoryName === "" ? {} : { repositoryName }
    hook = await loadSettlementHook(specifier, { env, repository, ...named })
    if (hook === undefined) return
    const settler = hook
    const stateDir = settlementStateDir(repository, segments)
    const journal = createReadOnlyJournal({ dir: repository.stateDir })
    const evictedThrough = journal.history?.diagnostics().evictedThrough
    if (evictedThrough !== undefined) {
      await registerSettlementWorker({ stateDir, owner: settler.owner, evictedThrough })
    }
    const drain = (retries: number) =>
      drainSettlements({
        repository,
        hook: settler,
        stateDir,
        ...named,
        retries,
        journal,
      })
    if (!habitant) {
      await report(await drain(BUSY_RETRIES), settler.owner)
      return
    }
    let parentIsExited = false
    const parentExited = new Promise<void>((done, fail) => {
      const lifetime = createReadStream("", { fd: 3, autoClose: true })
      lifetime.once("end", done)
      lifetime.once("error", fail)
      lifetime.resume()
    })
    void parentExited.then(() => {
      parentIsExited = true
      return undefined
    })
    const exitedBeforeActivation = await Promise.race([
      parentExited.then(() => true),
      sleep(HABITANT_ACTIVATION_MS).then(() => false),
    ])
    while (!exitedBeforeActivation && !parentIsExited) {
      await report(await drain(0), settler.owner)
      const exited = await Promise.race([parentExited.then(() => true), sleep(HABITANT_TICK_MS).then(() => false)])
      if (exited) break
    }
    await report(await drain(BUSY_RETRIES), settler.owner)
  } catch (error) {
    await report(error, hook?.owner)
  } finally {
    try {
      await hook?.close?.()
    } catch (error) {
      io.stderr(`warning: Yrd settlement hook did not close cleanly: ${detail(error)}\n`)
    }
  }
}

export type SettlementWorkerLaunch = Readonly<{
  /** Runtime that executes {@link scriptPath}; `process.execPath` in a real launch. */
  execPath: string
  scriptPath: string
  cwd: string
  env: Record<string, string | undefined>
  /** Repository the worker resumes in, independent of where the runtime lives. */
  settlementCwd: string
  noticePath: string
  repositoryName?: string
  habitant: boolean
  stderr: NodeJS.WriteStream | undefined
  warn: (text: string) => void
}>

/**
 * Start the detached worker.
 *
 * fd 3 is a pipe the worker never reads data from — it reads its END, which is
 * the parent's exit. A spawn failure only warns: settlement is background work
 * and the command that triggered it has already succeeded or failed on its own
 * terms.
 */
export function spawnYrdSettlementWorker(launch: SettlementWorkerLaunch): void {
  const failed = (error: Error): void => {
    launch.warn(
      `warning: Yrd could not start background completion work; command result unaffected: ` +
        `worker spawn failed: ${error.message}\n`,
    )
  }
  try {
    const child = spawn(launch.execPath, [launch.scriptPath, YRD_SETTLEMENT_COMMAND], {
      cwd: launch.cwd,
      detached: true,
      stdio: ["ignore", "ignore", launch.stderr?.isTTY === true ? "inherit" : "ignore", "pipe"],
      env: {
        ...launch.env,
        [YRD_SETTLEMENT_CWD_ENV]: launch.settlementCwd,
        [YRD_SETTLEMENT_REPOSITORY_NAME_ENV]: launch.repositoryName ?? "",
        [YRD_SETTLEMENT_NOTICE_PATH_ENV]: launch.noticePath,
        [YRD_SETTLEMENT_PARENT_PID_ENV]: String(process.pid),
        [YRD_SETTLEMENT_RESIDENT_ENV]: launch.habitant ? "1" : "0",
      } as NodeJS.ProcessEnv,
    })
    child.once("error", failed)
    // The lifetime pipe must not hold the parent's event loop open; only its
    // CLOSING is meaningful, and that happens when the parent exits.
    const lifetime = child.stdio[3] as Readonly<{ unref?: () => void }> | null | undefined
    lifetime?.unref?.()
    child.unref()
  } catch (error) {
    failed(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Deliver background failures a previous command's worker wrote down.
 *
 * Each notice is CLAIMED by rename before it is read, so two commands running
 * at once cannot print the same warning twice, and a notice whose shape this
 * reader does not understand is quarantined rather than dropped — an
 * unreadable failure record is still evidence that something failed.
 */
export function drainYrdSettlementNotices(noticeDir: string, write: (text: string) => void): void {
  if (!existsSync(noticeDir)) return
  let directory
  try {
    directory = opendirSync(noticeDir)
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return
    write(`yrd: cannot read prior settlement warnings (${detail(error)})\n`)
    return
  }
  let scanned = 0
  let capped = false
  const readEntry = () => {
    try {
      return directory.readSync()
    } catch (error) {
      // silent-fallback-allow: ENOENT is end-of-dir; other errors already wrote
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null
      write(`yrd: cannot scan prior settlement warnings (${detail(error)})\n`)
      return null
    }
  }
  try {
    while (scanned < NOTICE_SCAN_CAP) {
      const entry = readEntry()
      if (entry === null) break
      scanned++
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const path = join(noticeDir, entry.name)
      const claimed = `${path}.${process.pid}.${randomUUID()}.processing`
      try {
        renameSync(path, claimed)
      } catch (error) {
        if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") continue
        write(`yrd: cannot claim prior settlement warning ${path} (${detail(error)})\n`)
        continue
      }
      let result: Record<string, unknown>
      try {
        result = JSON.parse(readFileSync(claimed, "utf8")) as Record<string, unknown>
        // `failedAt` is required, not optional: a warning that cannot say how
        // old it is reads as current, and operators act on stale ones. Both
        // writers stamp it, so an undated or unparsable result is a legacy
        // artifact — quarantined with the rest of the unreadable evidence
        // rather than printed bare or rendered with a NaN age.
        if (
          result?.["version"] !== 1 ||
          typeof result["error"] !== "string" ||
          typeof result["commandCwd"] !== "string" ||
          typeof result["failedAt"] !== "string" ||
          !Number.isFinite(Date.parse(result["failedAt"]))
        ) {
          throw new Error("invalid result shape")
        }
      } catch (error) {
        write(`yrd: invalid prior settlement warning ${path} (${detail(error)})\n`)
        const invalidDir = join(noticeDir, "invalid")
        try {
          mkdirSync(invalidDir, { recursive: true })
          renameSync(claimed, join(invalidDir, `${entry.name}.${Date.now()}-${randomUUID()}.invalid`))
        } catch (quarantineError) {
          write(`yrd: cannot quarantine invalid settlement warning ${claimed} (${detail(quarantineError)})\n`)
        }
        continue
      }
      const owner = typeof result["owner"] === "string" && result["owner"] !== "" ? ` for ${result["owner"]}` : ""
      const failedAt = result["failedAt"] as string
      write(
        `warning: background work from a previous Yrd command${owner} failed in ` +
          `${result["commandCwd"] as string} ${formatDuration(Date.now() - Date.parse(failedAt))} ago ` +
          `(${failedAt}): ${result["error"] as string}\n`,
      )
      try {
        rmSync(claimed, { force: true })
      } catch (error) {
        write(`yrd: cannot remove delivered settlement warning ${claimed} (${detail(error)})\n`)
      }
    }
    if (scanned === NOTICE_SCAN_CAP && readEntry() !== null) capped = true
  } finally {
    directory.closeSync()
  }
  if (capped) write("yrd: additional prior settlement warnings remain for the next command\n")
}

/** A fresh notice path for one command's worker. */
export function settlementNoticePath(noticeDir: string): string {
  return join(noticeDir, `${Date.now()}-${process.pid}-${randomUUID()}.json`)
}

/** A `queue run` keeps a worker alive beside it; every other command drains
 * once and stops. Both spellings of `run` count — a `--once` drain commits the
 * same terminal facts a follow runner does. */
export function isQueueRunInvocation(args: readonly string[]): boolean {
  return args.some((arg, index) => arg === "queue" && args[index + 1] === "run")
}

export type YrdSettlementLaunch = Readonly<{
  /** True when the command this rides on is a queue runner. */
  habitant: boolean
  drainNotices(): void
  spawn(habitant: boolean): void
}>

export type YrdSettlementLaunchOptions = Readonly<{
  env: Record<string, string | undefined>
  args: readonly string[]
  execPath: string
  scriptPath: string
  cwd: string
  /** Repository this command operates on, when a composition already selected one. */
  operationRepository?: string
  repositoryName?: string
  /** Resolves the common Git directory that holds this command's out-of-band state. */
  gitDir: (selected: string | undefined) => string
  stderr: NodeJS.WriteStream | undefined
  write: (text: string) => void
}>

/**
 * Arrange settlement around one foreground command, or return undefined when
 * the host declared no hook.
 *
 * Runtime code and Yrd's mutable operation repository are separate concerns:
 * the worker resumes in the explicitly SELECTED repository, never in whatever
 * directory the runtime happens to live in.
 */
export function prepareYrdSettlementLaunch(options: YrdSettlementLaunchOptions): YrdSettlementLaunch | undefined {
  const specifier = options.env[YRD_SETTLEMENT_HOOK_ENV]?.trim()
  if (specifier === undefined || specifier === "") return undefined
  const segments = settlementStateSegments(options.env)
  const noticeDir = settlementNoticeDir(options.gitDir(options.operationRepository), segments)
  const noticePath = settlementNoticePath(noticeDir)
  const settlementCwd = options.operationRepository ?? options.env["YRD_REPO"]?.trim() ?? options.cwd
  return Object.freeze({
    habitant: isQueueRunInvocation(options.args),
    drainNotices: () => drainYrdSettlementNotices(noticeDir, options.write),
    spawn: (habitant: boolean) =>
      spawnYrdSettlementWorker({
        execPath: options.execPath,
        scriptPath: options.scriptPath,
        cwd: options.cwd,
        env: options.env,
        settlementCwd,
        noticePath,
        ...(options.repositoryName === undefined ? {} : { repositoryName: options.repositoryName }),
        habitant,
        stderr: options.stderr,
        warn: options.write,
      }),
  })
}
