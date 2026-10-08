/**
 * The durable close REQUEST (22894).
 *
 * A caller whose own same-UID CWD census is incomplete (26839's sandbox ptrace
 * scope; 28120's UNKNOWN=KEEP) cannot certify a close, and refusing blindly
 * leaves the environment to a human. It files its intent — the path, the
 * options it asked for, and the head it asked at — under the queue workdir; the
 * queue's own round is the context whose census reads every pid (ruling 27723),
 * and it runs the SAME close lifecycle the direct verb runs.
 *
 * The file carries INTENT and nothing else: never a census fact and never a
 * decision, so it is not a second safety authority beside removely's census
 * (26990 ruling 5). `coverageAttempts` is the consumer's own bound on a round
 * whose close also could not take a complete census; the requester never writes
 * it.
 */

import { createHash } from "node:crypto"
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { atomicWriteFileSync } from "@bearly/durable-file"

/** The one predicate a delegated close runs under: the direct verb's own admission. */
export const ENV_CLOSE_PREDICATE = "direct-admission"

/** The request directory under the run's existing state dir, never a new config key. */
export const ENV_CLOSE_REQUEST_DIRNAME = "env-close-requests"

/** How many rounds a coverage refusal may be retried before the request is retired. */
export const MAX_COVERAGE_ATTEMPTS = 3

export type EnvCloseRequestOptions = Readonly<{ retain?: string; noRehome?: boolean }>

export type EnvCloseRequest = Readonly<{
  name: string
  path: string
  requester: string
  /** The requester's real uid: a sanity check between files, never authority. */
  uid: number
  at: string
  predicate: typeof ENV_CLOSE_PREDICATE
  options: EnvCloseRequestOptions
  head: string
}>

/** What is stored on disk: the requester's intent plus the consumer's retry bound. */
export type StoredCloseRequest = EnvCloseRequest & Readonly<{ coverageAttempts?: number }>

/** The recorded requester: the launched seat identity, else `unknown` (cli.ts's own default). */
export function requesterOf(env: NodeJS.ProcessEnv): string {
  const launched = env.YRD_DEFAULT_SUBMITTER?.trim()
  return launched === undefined || launched === "" ? "unknown" : launched
}

export function closeRequestsDirectory(workdir: string): string {
  return join(workdir, "state", "yrd", ENV_CLOSE_REQUEST_DIRNAME)
}

/**
 * The file's derived name: the environment's own basename plus a short digest of
 * its path, so two same-named environments never share one file and the raw path
 * never becomes a name.
 */
export function closeRequestFile(workdir: string, path: string): string {
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 8)
  return join(closeRequestsDirectory(workdir), `${basename(path)}-${digest}.json`)
}

/**
 * Write the request, tmp+rename, or match the one that already stands.
 *
 * Idempotent for a re-request with the same path and options: the FIRST
 * requester and time survive, because the request is an intent and re-filing it
 * changes nothing. A standing request for the same path with DIFFERENT options
 * is a conflict, named with its requester and options, never overwritten. A file
 * this process cannot read, or one written by another uid, is refused loudly by
 * name: silent overwrite would hide a foreign writer (NO SILENT ERRORS).
 */
export function writeCloseRequest(
  workdir: string,
  request: EnvCloseRequest,
): Readonly<{ file: string; alreadyStood: boolean }> {
  const file = closeRequestFile(workdir, request.path)
  const standing = readCloseRequest(file)
  if (standing !== undefined) {
    if (standing.uid !== request.uid) {
      throw new Error(
        `close request ${file} was written by uid ${standing.uid}, not this caller's ${request.uid}; ` +
          `refusing to reuse a file this process does not own; inspect it before retrying`,
      )
    }
    if (standing.path !== request.path || !sameOptions(standing.options, request.options)) {
      throw new Error(
        `a close request for ${standing.path} already stands at ${file} from ${standing.requester} (${standing.at}) ` +
          `with options ${JSON.stringify(standing.options)}; this request asks for ${JSON.stringify(request.options)}; ` +
          `resolve the standing request before filing another`,
      )
    }
    return { file, alreadyStood: true }
  }
  try {
    publishCloseRequest(file, request)
  } catch (cause) {
    throw new Error(
      `close request for ${request.path} could not be written to ${file}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}; the environment was preserved; ` +
        `a context that can read every same-UID pid (the queue service's own round) must close it, ` +
        `or make ${dirname(file)} writable`,
      { cause },
    )
  }
  return { file, alreadyStood: false }
}

/** Read one request file. A malformed file is refused loudly; an absent one may be `undefined`. */
export function readCloseRequest(file: string): StoredCloseRequest | undefined {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error(`close request ${file} could not be read: ${String(cause)}`, { cause })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error(`close request ${file} is not JSON: ${String(cause)}; inspect it before retrying`, { cause })
  }
  return parseCloseRequest(parsed, file)
}

/** Every standing request file, in a stable order, ignoring the consumer's own `.processing` staging. */
export function listCloseRequests(workdir: string): readonly string[] {
  const directory = closeRequestsDirectory(workdir)
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new Error(`close request directory ${directory} could not be read: ${String(cause)}`, { cause })
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(directory, name))
}

/**
 * Move one request aside before it is acted on, so two consumers cannot both
 * close the same path and a crash mid-close leaves the file in a named place
 * rather than ambiguous. Returns the staged path.
 */
export function stageCloseRequest(file: string): string {
  const staged = join(dirname(file), ".processing", basename(file))
  try {
    mkdirSync(dirname(staged), { recursive: true, mode: 0o700 })
    renameSync(file, staged)
  } catch (cause) {
    throw new Error(`close request ${file} could not be staged at ${staged}: ${String(cause)}`, { cause })
  }
  return staged
}

/** Every request a dead round left staged, in a stable order: nothing stages silently. */
export function listStagedCloseRequests(workdir: string): readonly string[] {
  const directory = join(closeRequestsDirectory(workdir), ".processing")
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new Error(`staged close request directory ${directory} could not be read: ${String(cause)}`, { cause })
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(directory, name))
}

/**
 * Move a staged request back to its own name. Returns false when the slot is
 * already taken (a re-request stands, and the staged copy must never clobber
 * it): the link publishes only when the name is free.
 */
export function unstageCloseRequest(staged: string, file: string): boolean {
  try {
    linkSync(staged, file)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false
    throw new Error(`staged close request ${staged} could not be restored to ${file}: ${String(cause)}`, { cause })
  }
  removeFile(staged)
  return true
}

/** Put a staged request back under its own name, carrying the consumer's retry bound. */
export function restoreCloseRequest(staged: string, file: string, attempts: number): void {
  publishCloseRequest(file, { ...requireStaged(staged), coverageAttempts: attempts })
  removeFile(staged)
}

/** Delete a request file; an already-absent one is not a fault. */
export function dropCloseRequest(file: string): void {
  removeFile(file)
}

function requireStaged(staged: string): StoredCloseRequest {
  const stored = readCloseRequest(staged)
  if (stored === undefined) throw new Error(`staged close request ${staged} disappeared while it was being consumed`)
  return stored
}

function publishCloseRequest(file: string, request: StoredCloseRequest): void {
  atomicWriteFileSync(file, `${JSON.stringify(request)}\n`)
}

function removeFile(file: string): void {
  try {
    unlinkSync(file)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`close request ${file} could not be removed: ${String(cause)}`, { cause })
    }
  }
}

function sameOptions(left: EnvCloseRequestOptions, right: EnvCloseRequestOptions): boolean {
  return left.retain === right.retain && left.noRehome === right.noRehome
}

/** Strict, loud validation: a request this process cannot read is named, never guessed at. */
function parseCloseRequest(parsed: unknown, file: string): StoredCloseRequest {
  const bad = (why: string): Error =>
    new Error(`close request ${file} is malformed: ${why}; inspect it before retrying`)
  if (typeof parsed !== "object" || parsed === null) throw bad("not an object")
  const raw = parsed as Record<string, unknown>
  const text = (key: string): string => {
    const value = raw[key]
    if (typeof value !== "string" || value === "") throw bad(`${key} must be a non-empty string`)
    return value
  }
  if (raw.predicate !== ENV_CLOSE_PREDICATE) {
    throw bad(`predicate must be ${JSON.stringify(ENV_CLOSE_PREDICATE)}, read ${JSON.stringify(raw.predicate)}`)
  }
  if (typeof raw.uid !== "number" || !Number.isSafeInteger(raw.uid)) throw bad("uid must be a safe integer")
  const options = raw.options
  if (typeof options !== "object" || options === null) throw bad("options must be an object")
  const rawOptions = options as Record<string, unknown>
  if (rawOptions.retain !== undefined && typeof rawOptions.retain !== "string") {
    throw bad("options.retain must be a string")
  }
  if (rawOptions.noRehome !== undefined && typeof rawOptions.noRehome !== "boolean") {
    throw bad("options.noRehome must be a boolean")
  }
  const attempts = raw.coverageAttempts
  if (attempts !== undefined && (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0)) {
    throw bad("coverageAttempts must be a non-negative safe integer")
  }
  return {
    name: text("name"),
    path: text("path"),
    requester: text("requester"),
    uid: raw.uid,
    at: text("at"),
    predicate: ENV_CLOSE_PREDICATE,
    options: {
      ...(rawOptions.retain === undefined ? {} : { retain: rawOptions.retain }),
      ...(rawOptions.noRehome === undefined ? {} : { noRehome: rawOptions.noRehome }),
    },
    head: text("head"),
    ...(attempts === undefined ? {} : { coverageAttempts: attempts }),
  }
}
