/**
 * The one git seam the core runs through, and the three readings that turn a
 * non-zero exit into an answer.
 *
 * It is the existing process wrapper, unchanged: the plan reuses it rather than
 * growing a second way to spawn a child. Everything the core knows about a
 * repository comes through this function, so a test drives a real repository
 * and never a mock — the store is git, and a fake git would be a fake store.
 *
 * Git answers some questions with exit 1: "that ref is absent", "that commit
 * is not an ancestor", "nothing sets that configuration key". Those are
 * answers, not errors, and they are read here and nowhere else. Any other failure — a missing object, a bad sha, a broken
 * repository — is rethrown, because a wrong answer to either question would
 * merge or skip the wrong change (NO SILENT ERRORS).
 */

import { hostname } from "node:os"
import { randomUUID } from "node:crypto"
import { accessSync, constants, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { createProcess, resolveExecutable, type Process, type ProcessRequest, type ProcessResult } from "@yrd/process"
import type { Git } from "./records.ts"

export type GitSelection = Readonly<{
  executable: string
  contract: "native" | "root-v1"
  scope: "default" | "system" | "global" | "local" | "worktree"
  origin: string
}>

// Uniform invocation bounds. The 15-component measurement owns any revision;
// expiry reports uncertainty and never establishes that a mutation had no effect.
const GIT_READINESS_MS = 5_000
const GIT_ROOT_INVOCATION_MS = 5 * 60_000
const GIT_CONTROL_BYTES = 64 * 1024

type GitRefusal = Readonly<{ kind: "waiting" | "rejected" | "unjudged"; message: string }>
export type GitInvocation = Readonly<{
  args: readonly string[]
  cwd: string
  selection?: GitSelection
  result?: ProcessResult
  protocol?: Readonly<{ token: string; ready: boolean; refusal?: GitRefusal }>
  /** An invocation defect, distinct from an ordinary nonzero Git exit. */
  failure?: string
  artifacts?: Readonly<{ stdout: string; stderr: string; complete: boolean }>
}>

export type GitOutputSink = Readonly<{
  stdout: string
  stderr: string
  onOutput: NonNullable<ProcessRequest["onOutput"]>
  /** Close both streams, reporting write/close failures. */
  close(): void
}>

export type GitInvocationOptions = Readonly<{
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  openOutput?: (invocation: Pick<GitInvocation, "args" | "cwd" | "selection">) => GitOutputSink
  onInvocation?: (invocation: GitInvocation) => void
}>

export type GitRunner = Git &
  Readonly<{
    /** Bounded evidence for the latest settled call, including successful stderr.
     * Run owners use onInvocation to retain every call in their existing log. */
    lastInvocation: GitInvocation | undefined
  }>

/** One machine declaration, resolved before owning-repository operations. */
export async function resolveGitSelection(
  cwd: string,
  options: Readonly<{ process?: Pick<Process, "run">; env?: NodeJS.ProcessEnv }> = {},
): Promise<GitSelection> {
  const env = gitEnvironment(options.env ?? globalThis.process.env)
  if (options.process === undefined) {
    await using process = createProcess({ cwd, env })
    return await resolveGitSelection(cwd, { ...options, process })
  }
  const problem = (message: string, origin = "native Git file scopes") =>
    new Error(`yrd: yrd.git in ${cwd} (${origin}): ${message}`)
  let result: Awaited<ReturnType<Process["run"]>>
  try {
    result = await options.process.run({
      argv: ["git", "config", "--null", "--show-scope", "--show-origin", "--get-all", "yrd.git"],
      cwd,
      env,
      timeoutMs: GIT_READINESS_MS,
    })
  } catch (error) {
    throw problem(`cannot read the declaration: ${String(error)}`)
  }
  if (
    result.signal !== null ||
    result.timedOut ||
    result.stalled ||
    result.sweepFailure !== undefined ||
    result.escapedDescendant ||
    (result.outputTruncation?.length ?? 0) > 0
  ) {
    throw problem(`native config read did not settle completely: ${JSON.stringify(result)}`)
  }
  if (result.exitCode === 1 && result.stdout === "" && result.stderr === "") {
    return Object.freeze({
      executable: selectedExecutable("git", env, problem),
      contract: "native",
      scope: "default",
      origin: "yrd.git absent",
    })
  }
  if (result.exitCode !== 0) {
    throw problem(
      `cannot read the declaration: native config exited ${result.exitCode}: ${result.stderr || result.stdout}`,
    )
  }
  const fields = result.stdout.split("\0")
  if (fields.pop() !== "" || fields.length === 0 || fields.length % 3 !== 0) {
    throw problem("native Git returned malformed scope/origin/value fields")
  }
  let selected:
    | Readonly<{ scope: Exclude<GitSelection["scope"], "default">; origin: string; value: string }>
    | undefined
  for (let at = 0; at < fields.length; at += 3) {
    const [scope, origin, value] = fields.slice(at, at + 3)
    if (scope === "command") {
      throw problem("command-scope selection is not permitted; declare this value in a Git configuration file", origin)
    }
    if (
      (scope !== "system" && scope !== "global" && scope !== "local" && scope !== "worktree") ||
      origin === undefined ||
      value === undefined
    ) {
      throw problem(`unsupported configuration scope ${String(scope)}`, origin)
    }
    selected = { scope, origin, value }
  }
  if (selected === undefined) throw problem("native Git returned no declaration after a successful query")
  const { scope, origin, value } = selected
  if (value === "") throw problem("a present value is empty", origin)
  let declaration: unknown
  try {
    declaration = JSON.parse(value)
  } catch (error) {
    throw problem(`expected a JSON executable/contract declaration: ${String(error)}`, origin)
  }
  if (
    typeof declaration !== "object" ||
    declaration === null ||
    Array.isArray(declaration) ||
    Object.keys(declaration).length !== 2 ||
    !("executable" in declaration) ||
    typeof declaration.executable !== "string" ||
    !("contract" in declaration) ||
    (declaration.contract !== "native" && declaration.contract !== "root-v1")
  ) {
    throw problem("expected exactly executable and contract, with contract native or root-v1", origin)
  }
  const executable = selectedExecutable(declaration.executable, env, (message) => problem(message, origin))
  return Object.freeze({ executable, contract: declaration.contract, scope, origin })
}

function selectedExecutable(command: string, env: NodeJS.ProcessEnv, problem: (message: string) => Error): string {
  if (command === "" || /[\0\r\n]/u.test(command) || (!isAbsolute(command) && /[\s/\\]/u.test(command))) {
    throw problem("executable must be one absolute path or bare command name")
  }
  const resolved = resolveExecutable(
    command,
    Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  )
  try {
    if (!isAbsolute(resolved)) throw new Error("not found on the selected environment's PATH")
    accessSync(resolved, constants.X_OK)
    if (!statSync(resolved).isFile()) throw new Error("not a regular executable file")
  } catch (error) {
    throw problem(`executable ${JSON.stringify(command)} is unavailable: ${String(error)}`)
  }
  return resolved
}

/**
 * A git runner rooted at one repository. Non-zero exits throw, loudly.
 *
 * Two settings travel in its environment (`gitEnvironment`), so no call site
 * can forget them: the caller's routing variables are scrubbed, and neither a
 * fetch nor a push recurses into submodules. The superproject sets
 * `submodule.recurse=true`, under which every fetch visits all sixteen
 * submodules (measured 2026-09-03: 16 s against 1 s for the change refs), and
 * a push of a change that moved a gitlink tries to push the submodule with the
 * superproject's refspec and dies there (`src refspec refs/yrd/changes/… must
 * name a ref`, @dev/2, 2026-09-03). Worktrees get their submodules from
 * materialization (worktree.ts), never from a fetch; a moved gitlink is judged
 * by the built-in check at queue time, never pushed by the submit.
 */
export function gitIn(
  cwd: string,
  process?: Pick<Process, "run">,
  selection?: GitSelection,
  options: GitInvocationOptions = {},
): GitRunner {
  const env = options.env === undefined ? undefined : gitEnvironment(options.env)
  const runner = process ?? createProcess({ cwd, env: env ?? gitEnvironment(globalThis.process.env) })
  let lastInvocation: GitInvocation | undefined
  const git: Git = async (originalArgs, input) => {
    const args = Object.freeze([...originalArgs])
    let evidence = await invokeGit(
      runner,
      { args, cwd, ...(selection === undefined ? {} : { selection }) },
      options,
      env,
      input,
    )
    lastInvocation = evidence
    try {
      options.onInvocation?.(evidence)
    } catch (error) {
      // Publication is not allowed to replace the settled invocation with an
      // unrelated filesystem error. Do not retry a possibly partial record.
      const artifacts = evidence.artifacts
      const publicationFailure = `Git evidence publication failed: ${String(error)}${artifacts === undefined ? "" : `; raw stdout: ${artifacts.stdout}; raw stderr: ${artifacts.stderr}`}`
      evidence = { ...evidence, failure: [evidence.failure, publicationFailure].filter(Boolean).join("; ") }
      lastInvocation = evidence
    }
    const result = evidence.result
    const refusal = evidence.protocol?.refusal
    if (evidence.failure !== undefined || refusal !== undefined || result === undefined || result.exitCode !== 0) {
      const detail =
        evidence.failure ??
        refusal?.message ??
        (result?.stderr.trim() || result?.stdout.trim() || "Git invocation returned no result")
      throw new GitExit(args, cwd, result?.exitCode ?? -1, detail, evidence)
    }
    return result.stdout
  }
  return Object.defineProperty(git, "lastInvocation", { get: () => lastInvocation }) as GitRunner
}

async function invokeGit(
  runner: Pick<Process, "run">,
  invocation: Pick<GitInvocation, "args" | "cwd" | "selection">,
  options: GitInvocationOptions,
  env: NodeJS.ProcessEnv | undefined,
  input: string | undefined,
): Promise<GitInvocation> {
  const { args, cwd, selection } = invocation
  const abort = new AbortController()
  const protocol = selection?.contract === "root-v1" ? new GitProtocol(abort) : undefined
  const timeoutMs =
    protocol === undefined
      ? options.timeoutMs
      : Math.min(options.timeoutMs ?? GIT_ROOT_INVOCATION_MS, GIT_ROOT_INVOCATION_MS)
  let output: GitOutputSink | undefined
  let closed = false
  let result: ProcessResult | undefined
  let failure: string | undefined
  try {
    output = options.openOutput?.(invocation)
    result = await runner.run({
      argv: [selection?.executable ?? "git", ...(protocol === undefined ? [] : ["--protocol-fd=3"]), ...args],
      cwd,
      captureRawOutput: true,
      ...(env === undefined ? {} : { env }),
      ...(input === undefined ? {} : { stdin: input }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      signal: options.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, options.signal]),
      ...(output === undefined ? {} : { onOutput: output.onOutput }),
      ...(protocol === undefined ? {} : { onStart: () => protocol.start(), extraStdio: protocol.port }),
    })
    failure = protocol?.finish(result) ?? incompleteGitResult(result)
  } catch (error) {
    failure = `Git invocation failed: ${String(error)}`
  } finally {
    protocol?.clearDeadline()
    try {
      output?.close()
      closed = true
    } catch (error) {
      failure = [failure, `raw Git output could not be closed: ${String(error)}`].filter(Boolean).join("; ")
    }
  }
  return {
    ...invocation,
    ...(result === undefined ? {} : { result }),
    ...(protocol === undefined ? {} : { protocol: protocol.value }),
    ...(failure === undefined ? {} : { failure }),
    ...(output === undefined
      ? {}
      : {
          artifacts: {
            stdout: output.stdout,
            stderr: output.stderr,
            complete: closed && result !== undefined && incompleteGitResult(result, false) === undefined,
          },
        }),
  }
}

function incompleteGitResult(result: ProcessResult, requireCompleteCapture = true): string | undefined {
  if (
    result.signal !== null ||
    result.timedOut ||
    result.stalled ||
    result.sweepFailure !== undefined ||
    result.escapedDescendant
  ) {
    return `Git process did not settle completely: signal=${String(result.signal)}, timedOut=${String(result.timedOut)}, stalled=${String(result.stalled ?? false)}, escapedDescendant=${String(result.escapedDescendant ?? false)}, sweepFailure=${String(result.sweepFailure ?? "none")}`
  }
  if (requireCompleteCapture && (result.outputTruncation?.length ?? 0) > 0) {
    return "Git output capture is incomplete; raw evidence records the retained bytes and any gap"
  }
  return undefined
}

/** The one incremental parser owns early readiness and final frame validation.
 * Raw control bytes remain with Process; this only retains the current line. */
class GitProtocol {
  readonly token = randomUUID()
  readonly greeting = new TextEncoder().encode(`${JSON.stringify({ version: 1, token: this.token })}\n`)
  readonly decoder = new TextDecoder("utf-8", { fatal: true })
  ready = false
  refusal: GitRefusal | undefined
  failure: string | undefined
  pending = ""
  received = 0
  deadline: ReturnType<typeof setTimeout> | undefined
  readonly port: NonNullable<ProcessRequest["extraStdio"]>

  constructor(readonly abort: AbortController) {
    this.port = { input: this.greeting, maxBytes: GIT_CONTROL_BYTES, onData: (chunk) => this.read(chunk) }
  }

  get value(): NonNullable<GitInvocation["protocol"]> {
    return { token: this.token, ready: this.ready, ...(this.refusal === undefined ? {} : { refusal: this.refusal }) }
  }

  start(): void {
    this.deadline = setTimeout(
      () => this.fail(`missing ready after ${GIT_READINESS_MS} ms; mutation effects are unknown`),
      GIT_READINESS_MS,
    )
  }

  clearDeadline(): void {
    clearTimeout(this.deadline)
    this.deadline = undefined
  }

  fail(message: string): void {
    this.failure ??= `Git protocol: ${message}`
    this.clearDeadline()
    this.abort.abort()
  }

  read(chunk: Uint8Array): void {
    if (this.failure !== undefined) return
    this.received += chunk.byteLength
    if (this.received > GIT_CONTROL_BYTES) {
      this.fail(`control exceeded ${GIT_CONTROL_BYTES} bytes`)
      return
    }
    try {
      this.pending += this.decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = this.pending.indexOf("\n")) >= 0) {
        const line = this.pending.slice(0, end)
        this.pending = this.pending.slice(end + 1)
        this.frame(JSON.parse(line))
      }
    } catch (error) {
      this.fail(`invalid UTF-8/JSON frame: ${String(error)}`)
    }
  }

  frame(row: unknown): void {
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("expected frame fields")
    if (!("version" in row) || row.version !== 1 || !("token" in row) || row.token !== this.token) {
      throw new Error("version/token mismatch")
    }
    if ("ready" in row) {
      if (Object.keys(row).length !== 3 || row.ready !== true) throw new Error("invalid ready fields")
      if (this.ready) throw new Error("duplicate ready")
      this.ready = true
      this.clearDeadline()
      return
    }
    if (!this.ready) throw new Error("refusal before ready")
    if (this.refusal !== undefined) throw new Error("duplicate refusal")
    if (
      !("refusal" in row) ||
      (row.refusal !== "waiting" && row.refusal !== "rejected" && row.refusal !== "unjudged")
    ) {
      throw new Error("unknown refusal")
    }
    if (Object.keys(row).length !== 4 || !("message" in row) || typeof row.message !== "string") {
      throw new Error("invalid refusal fields")
    }
    this.refusal = { kind: row.refusal, message: row.message }
  }

  finish(result: ProcessResult): string | undefined {
    this.clearDeadline()
    if (this.failure !== undefined) return this.failure
    try {
      this.pending += this.decoder.decode()
    } catch (error) {
      return `Git protocol: incomplete UTF-8: ${String(error)}`
    }
    if (this.pending !== "") return "Git protocol: incomplete frame"
    if (!this.ready) return "Git protocol: missing ready; mutation effects are unknown"
    const port = result.extraStdio
    if (
      port === undefined ||
      port.failure !== undefined ||
      !port.eof ||
      port.inputBytesWritten !== this.greeting.length ||
      port.bytes.length !== port.totalBytes
    ) {
      return `Git protocol: control stream did not settle completely: ${port?.failure ?? "missing endpoint, EOF, greeting bytes or complete capture"}`
    }
    const incomplete = incompleteGitResult(result)
    if (incomplete !== undefined) return incomplete
    if (this.refusal !== undefined && result.exitCode === 0) return "Git protocol: refusal with exit 0"
    return undefined
  }
}

/**
 * The variables git honours ahead of `cwd` when choosing a repository. A
 * `git yrd` subcommand inherits them from git itself; a caller's shell may
 * carry them by accident. Everything else passes: a user's `GIT_SSH_COMMAND`,
 * a test's `GIT_CONFIG_*`.
 */
const ROUTING_VARIABLES = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
])

/**
 * The caller's environment without its routing variables, plus the queue's own
 * git configuration and its own committer identity.
 *
 * Every commit the queue makes is committed by `yrd-service@<host>`, so
 * `git log --format=%cn` tells the queue's merges from a person's without
 * reading a single one of its refs. The AUTHOR is untouched: whoever wrote the
 * change wrote it, and a merge commit's author is the run's git identity as it
 * always was.
 */
export function gitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !ROUTING_VARIABLES.has(key)),
  )
  const declared = Number(env.GIT_CONFIG_COUNT ?? "0")
  const count = Number.isInteger(declared) && declared >= 0 ? declared : 0
  return {
    ...env,
    GIT_COMMITTER_EMAIL: `yrd-service@${hostname()}`,
    GIT_COMMITTER_NAME: "yrd-service",
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: "fetch.recurseSubmodules",
    [`GIT_CONFIG_VALUE_${count}`]: "no",
    [`GIT_CONFIG_KEY_${count + 1}`]: "push.recurseSubmodules",
    [`GIT_CONFIG_VALUE_${count + 1}`]: "no",
  }
}

export class GitExit extends Error {
  constructor(
    readonly args: readonly string[],
    readonly cwd: string,
    readonly exitCode: number,
    /** What git itself said: its stderr, or its stdout when stderr was empty. */
    readonly detail: string,
    readonly evidence?: GitInvocation,
  ) {
    super(`git ${args.join(" ")} in ${cwd} exited ${exitCode}: ${detail}`)
    this.name = "GitExit"
  }
}

/**
 * The object a name resolves to, or undefined when absent. A ref is peeled to
 * its commit; a `rev:path` names a blob already and git refuses a peel on it,
 * so it is asked for as written.
 */
export async function refAt(
  git: Git,
  ref: string,
  kind: "commit" | "blob" | "tree" = "commit",
): Promise<string | undefined> {
  try {
    const name = kind === "commit" ? `${ref}^{commit}` : ref
    const out = (await git(["rev-parse", "--verify", "--quiet", name])).trim()
    if (out === "") throw new Error(`git rev-parse --verify --quiet ${name} succeeded with empty output`)
    return out
  } catch (error) {
    const result = error instanceof GitExit ? error.evidence?.result : undefined
    if (isExit(error, 1) && result?.stdout === "" && result.stderr === "") return undefined
    throw error
  }
}

/** Capture one advertised commit without changing refs or FETCH_HEAD. */
export async function readRemoteCommit(git: Git, remote: string, ref: string): Promise<string | undefined> {
  const rows = (await git(["ls-remote", "--refs", remote, ref]))
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean)
  if (rows.length === 0) return undefined
  if (rows.length !== 1) throw new Error(`${remote} answered with ${String(rows.length)} values for ${ref}`)
  const [sha, name] = (rows[0] ?? "").split(/\s+/u)
  if (name !== ref || sha === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)) {
    throw new Error(`${remote} returned an unreadable ${ref} advertisement: ${rows[0]}`)
  }
  try {
    await git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--refmap=", remote, sha])
  } catch (cause) {
    throw new Error(`${remote} advertised ${ref} at ${sha}, but fetching that commit failed: ${String(cause)}`, {
      cause,
    })
  }
  return sha
}

/** Whether `sha` is an ancestor of `of`. */
export async function isAncestor(git: Git, sha: string, of: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", sha, of])
    return true
  } catch (error) {
    if (isExit(error, 1)) return false
    throw error
  }
}

/**
 * One git configuration value as this repository resolves it — every scope git
 * honours, in git's own order — or undefined when nothing sets it. Git spells
 * "no such key" as exit 1, the third of the three answers this file reads.
 *
 * `--default ""` would answer without an exit, but an empty argv string is
 * refused before git sees it (`@yrd/process`), so the exit is read instead.
 */
export async function configValue(git: Git, name: string): Promise<string | undefined> {
  try {
    const out = (await git(["config", "--get", name])).trim()
    return out === "" ? undefined : out
  } catch (error) {
    if (isExit(error, 1)) return undefined
    throw error
  }
}

/** The merge base of two commits, or undefined when their histories are unrelated. */
export async function mergeBase(git: Git, left: string, right: string): Promise<string | undefined> {
  try {
    const out = (await git(["merge-base", left, right])).trim()
    return out === "" ? undefined : out
  } catch (error) {
    if (isExit(error, 1)) return undefined
    throw error
  }
}

function isExit(error: unknown, code: number): boolean {
  return (
    error instanceof GitExit &&
    error.exitCode === code &&
    error.evidence?.failure === undefined &&
    error.evidence?.protocol?.refusal === undefined
  )
}

/**
 * The gitlink rows of one tree-to-tree diff, read as git prints it with `-z`
 * — `:<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0` per entry
 * — for every path a gitlink stands at on either side: added, moved, or taken
 * out. `sha` is the new side's, the zero sha for a gitlink taken out.
 */
export async function gitlinkRows(
  git: Git,
  from: string,
  to: string,
): Promise<readonly Readonly<{ path: string; oldMode: string; newMode: string; sha: string }>[]> {
  const fields = (await git(["diff-tree", "-r", "-z", "--no-renames", from, to])).split("\0")
  const rows: { path: string; oldMode: string; newMode: string; sha: string }[] = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [colonOldMode, newMode, , newSha] = (fields[at] ?? "").split(" ")
    const oldMode = colonOldMode?.replace(/^:/u, "")
    const path = fields[at + 1]
    if (oldMode === undefined || newMode === undefined || newSha === undefined || path === undefined || path === "") {
      continue
    }
    if (oldMode !== "160000" && newMode !== "160000") continue
    rows.push({ newMode, oldMode, path, sha: newSha })
  }
  return rows
}
