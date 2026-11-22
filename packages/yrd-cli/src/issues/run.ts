/**
 * `yrd issues <verb>` — the one reader of a project's issues declaration (design `issues-interface` rev 6 § 4–§ 6,
 * @cto ruling 0e9e794e). It finds the project, reads `issues.yml` from one pinned commit of `main`, and runs the
 * provider argv declared for the verb. Resolve validates opaque keys; other provider JSON is passed back whole.
 *
 * Never a clone, a fetch or a working-tree read: the declaration in force is the one committed on `main`.
 * Automatic replay pins the delivered declaration. If its provider no longer runs, replay fails loudly;
 * moving old merges to a new backend requires an explicit operator action.
 */
import { realpathSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { cleanGitEnvironment, createProcess } from "@yrd/process"
// Gitomic only through Yrd's one configured git seam (gitomic-boundary.test.ts): scrubbed env, bounded calls.
import { createLegacyBackend, gitIn, isAncestor, openReader, resolveGitSelection } from "@yrd/queue-core"
import {
  ISSUES_CLOSE_REASONS,
  ISSUES_CODES,
  ISSUES_EVENT_KINDS,
  ISSUES_DECLARATION_PATH,
  ISSUES_VERBS,
  ISSUES_VERB_NAMES,
  ISSUES_WRITE_VERBS,
  IssuesDeclarationError,
  isIssuesVerb,
  parseIssuesDeclaration,
  substituteArgv,
  type IssuesCode,
  type IssuesVerb,
} from "./declaration.ts"
import {
  OWNER_ACTIVITY_WINDOW_MS,
  annotateInProgress,
  readActivity,
  type IssuesActivityEvent,
  type IssuesEnvironmentHold,
} from "./in-progress.ts"

export type { IssuesActivityEvent, IssuesEnvironmentHold } from "./in-progress.ts"

export type IssuesEnvelope = Readonly<{
  declaration: Readonly<{ repository: string; commit: string; path: typeof ISSUES_DECLARATION_PATH }>
  verb: IssuesVerb
  result: unknown
}>

/** Exit 1: refused or failed with a named cause. Exit 2: the request itself is malformed. */
export type IssuesFailure = Readonly<{ ok: false; exitCode: 1 | 2; code: IssuesCode; message: string }>

export type IssuesOutcome = Readonly<{ ok: true; envelope: IssuesEnvelope }> | IssuesFailure

type IssuesRequester = Readonly<{ authority: string; subject: string }>
type IssuesAssignmentAudit = Readonly<{ expectedOwner?: string | null; requestedBy?: IssuesRequester }>

export type RunIssuesVerbOptions = Readonly<{
  verb: string
  /** The verb's positional operands, in {@link ISSUES_VERBS} order. */
  args: readonly string[]
  /** The replay key; required by every write verb. */
  id?: string
  /** Owner observed by the assign caller. Explicit null means no owner was present. */
  expectedOwner?: IssuesAssignmentAudit["expectedOwner"]
  /** Provider-neutral requester audit data. The provider validates its own authority policy. */
  requestedBy?: IssuesAssignmentAudit["requestedBy"]
  /** The project root; absent, the toplevel of `cwd`'s repository. */
  projectRoot?: string
  /** Read this exact ancestor of main; automatic effects use their delivered merge commit. */
  declarationCommit?: string
  /**
   * With {@link declarationCommit}: prove its ancestry against this commit instead of the project's main. Yrd's
   * post-merge passes the target its own round published, which a clone's main can lag by seconds (#31194).
   */
  targetCommit?: string
  /** The caller's directory: where discovery starts and where the provider runs. */
  cwd: string
  /** The provider's environment, inherited whole. Defaults to this process's. */
  env?: NodeJS.ProcessEnv
  /** Kill the provider after this long and fail with {@link ISSUES_CODES.providerTimedOut}. */
  timeoutMs?: number
  /** Kill the provider after this long without output, once it has written a byte; fails with
   * {@link ISSUES_CODES.providerStalled}. */
  noProgressTimeoutMs?: number
  /** Cancel and reap this provider when its caller stops. */
  signal?: AbortSignal
  /** Where the provider's stderr passes through. Defaults to this process's stderr. */
  stderr?: (text: string) => void
  /**
   * #37838: the environments that hold an issue open, for the computed `in_progress` columns on `view`,
   * `list-page` and `list`. Absent, the provider's JSON passes back whole: the columns cost an environment read,
   * so a caller that does not show them (post-merge's close checks, env-close's release state) never pays it.
   */
  environments?: (input: Readonly<{ root: string; cwd: string }>) => Promise<readonly IssuesEnvironmentHold[]>
}>

function fail(exitCode: 1 | 2, code: IssuesCode, subject: string, detail: string): IssuesFailure {
  return { ok: false, exitCode, code, message: `${code}: ${subject}: ${detail}` }
}

/** The reads whose rows Yrd can complete with its own environments (#37838). */
const IN_PROGRESS_VERBS: ReadonlySet<string> = new Set(["view", "list-page", "traverse", "list"])

function commandText(argv: readonly string[]): string {
  return argv.map((word) => (word === "" || /[\s"'`$\\]/u.test(word) ? JSON.stringify(word) : word)).join(" ")
}

function isExpectedOwner(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function isIssuesRequester(value: unknown): value is IssuesRequester {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const identity = value as Record<string, unknown>
  return (
    Object.keys(identity).length === 2 &&
    Object.hasOwn(identity, "authority") &&
    typeof identity.authority === "string" &&
    identity.authority.length > 0 &&
    Object.hasOwn(identity, "subject") &&
    typeof identity.subject === "string" &&
    identity.subject.length > 0
  )
}

const EXPECTED_OWNER_JSON = "--expected-owner requires a JSON string or null"
const REQUESTED_BY_JSON = "--requested-by requires a JSON object with authority and subject strings"

function parseAssignJson(text: string, error: string): unknown {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new TypeError(error, { cause })
  }
}

/** Decode Commander operands into the same typed options used by library callers. */
export function parseIssuesAssignmentAudit(
  expectedOwnerJson?: string,
  requestedByJson?: string,
): IssuesAssignmentAudit {
  const expectedOwner =
    expectedOwnerJson === undefined ? undefined : parseAssignJson(expectedOwnerJson, EXPECTED_OWNER_JSON)
  const requestedBy = requestedByJson === undefined ? undefined : parseAssignJson(requestedByJson, REQUESTED_BY_JSON)
  if (expectedOwner !== undefined && !isExpectedOwner(expectedOwner)) throw new TypeError(EXPECTED_OWNER_JSON)
  if (requestedBy !== undefined && !isIssuesRequester(requestedBy)) throw new TypeError(REQUESTED_BY_JSON)
  return {
    ...(expectedOwner === undefined ? {} : { expectedOwner }),
    ...(requestedBy === undefined ? {} : { requestedBy }),
  }
}

/** Validate the request before any git read: a malformed call is exit 2 whatever the declaration says. */
function checkRequest(
  options: RunIssuesVerbOptions,
): IssuesFailure | Readonly<{ ok: true; values: Readonly<Record<string, string>> }> {
  const { verb } = options
  if (!isIssuesVerb(verb)) {
    return fail(2, ISSUES_CODES.badArguments, verb, `not a verb; the verbs are ${ISSUES_VERB_NAMES.join(", ")}`)
  }
  const operands: readonly string[] = ISSUES_VERBS[verb]
  if (options.args.length !== operands.length) {
    return fail(
      2,
      ISSUES_CODES.badArguments,
      verb,
      `takes ${operands.length === 0 ? "no operands" : operands.map((name) => `<${name}>`).join(" ")}, got ${options.args.length}`,
    )
  }
  const values: Record<string, string> = {}
  operands.forEach((name, index) => {
    values[name] = options.args[index] as string
  })
  if (verb === "list-page") {
    const detail = "<page> must be a JSON object describing a finite page request"
    let page: unknown
    try {
      page = JSON.parse(values.page as string)
    } catch {
      return fail(2, ISSUES_CODES.badArguments, verb, detail)
    }
    if (page === null || typeof page !== "object" || Array.isArray(page)) {
      return fail(2, ISSUES_CODES.badArguments, verb, detail)
    }
  }
  if (verb === "close" && !(ISSUES_CLOSE_REASONS as readonly string[]).includes(values.reason as string)) {
    return fail(
      2,
      ISSUES_CODES.badArguments,
      `close ${JSON.stringify(values.reason)}`,
      `reason must be ${ISSUES_CLOSE_REASONS.join(" or ")}`,
    )
  }
  if (verb === "event" && !(ISSUES_EVENT_KINDS as readonly string[]).includes(values.kind as string)) {
    return fail(
      2,
      ISSUES_CODES.badArguments,
      `event ${JSON.stringify(values.kind)}`,
      `kind must be ${ISSUES_EVENT_KINDS.join(", ")}`,
    )
  }
  const { expectedOwner, requestedBy } = options
  if ((expectedOwner !== undefined || requestedBy !== undefined) && verb !== "assign") {
    return fail(2, ISSUES_CODES.badArguments, verb, "--expected-owner and --requested-by apply only to assign")
  }
  if (expectedOwner !== undefined) {
    if (!isExpectedOwner(expectedOwner)) return fail(2, ISSUES_CODES.badArguments, verb, EXPECTED_OWNER_JSON)
    values["expected-owner"] = JSON.stringify(expectedOwner)
  }
  if (requestedBy !== undefined) {
    if (!isIssuesRequester(requestedBy)) return fail(2, ISSUES_CODES.badArguments, verb, REQUESTED_BY_JSON)
    values.requester = JSON.stringify({ authority: requestedBy.authority, subject: requestedBy.subject })
  }
  if (options.targetCommit !== undefined && options.declarationCommit === undefined) {
    return fail(2, ISSUES_CODES.badArguments, verb, "targetCommit is the ancestry tip for declarationCommit; pass both")
  }
  if (ISSUES_WRITE_VERBS.has(verb)) {
    if (options.id === undefined || options.id === "") {
      return fail(2, ISSUES_CODES.badArguments, verb, "--id <id> is required: the replay key the provider dedupes on")
    }
    values.id = options.id
  }
  for (const [name, bound] of [
    ["timeoutMs", options.timeoutMs],
    ["noProgressTimeoutMs", options.noProgressTimeoutMs],
  ] as const) {
    if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 1)) {
      return fail(
        2,
        ISSUES_CODES.badArguments,
        `${name} ${String(bound)}`,
        "must be a positive integer of milliseconds",
      )
    }
  }
  return { ok: true, values }
}

async function git(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  await using process = createProcess({ cwd, env: { ...cleanGitEnvironment(env), GIT_TERMINAL_PROMPT: "0" } })
  const result = await process.run({ argv: ["git", ...args], cwd, timeoutMs: 30_000 })
  return { exitCode: result.exitCode, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

function sameDirectory(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    // silent-fallback-allow: a path that cannot be resolved is not the same directory; the caller refuses loudly.
    return false
  }
}

/** True when `path` is itself a repository: a bare one's git dir, or a non-bare one's toplevel. */
async function isRepositoryAt(path: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  // git cannot be spawned in a directory that does not exist; that path is plainly not a repository.
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) return false
  const bare = await git(["rev-parse", "--is-bare-repository", "--absolute-git-dir"], path, env)
  if (bare.exitCode !== 0) return false
  const [isBare, gitDir] = bare.stdout.split("\n")
  if (isBare === "true") return gitDir !== undefined && sameDirectory(gitDir, path)
  const top = await git(["rev-parse", "--show-toplevel"], path, env)
  return top.exitCode === 0 && sameDirectory(top.stdout, path)
}

/** `scheme://…` — a URL git transports over (ssh, https, git, …). `file://` is matched before this. */
const SCHEME_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u
/** git's scp-like `[user@]host:path`: a colon before any slash, e.g. `git@github.com:beorn/x.git`. */
const SCP_LIKE = /^(?:[^@/:\s]+@)?[^@/:\s]+:/u

/**
 * The repository to read: the root's origin when that origin is local, else the root itself. An origin is remote
 * only on a positive match (`scheme://` or scp-like `host:path`); `file://` and absolute paths are local; every
 * other spelling — a relative path above all — is refused by name rather than resolved the way git would.
 */
async function repositoryToRead(root: string, env: NodeJS.ProcessEnv): Promise<IssuesFailure | string> {
  const origin = await git(["config", "--get", "remote.origin.url"], root, env)
  // `git config --get` exits 1 for an unset key: no origin, so the root is the repository.
  if (origin.exitCode === 1 && origin.stdout === "") return root
  if (origin.exitCode !== 0) {
    return fail(1, ISSUES_CODES.notARepository, root, `git config --get remote.origin.url failed: ${origin.stderr}`)
  }
  const url = origin.stdout
  let local: string
  if (url.startsWith("file://")) local = fileURLToPath(url)
  else if (isAbsolute(url)) local = url
  else if (SCHEME_URL.test(url) || SCP_LIKE.test(url)) return root
  else {
    return fail(
      1,
      ISSUES_CODES.originUnsupported,
      root,
      `origin ${JSON.stringify(url)} is neither a local repository (file:// or an absolute path) ` +
        "nor a remote URL (scheme:// or host:path); spell it as one of those",
    )
  }
  if (!(await isRepositoryAt(local, env))) {
    return fail(
      1,
      ISSUES_CODES.originNotARepository,
      root,
      `origin ${JSON.stringify(url)} names a local path that is not a git repository`,
    )
  }
  return local
}

/**
 * #37838 (@cto 8e7cbb99): how many provider pages ONE traversal may read before it refuses. A page limit is the
 * difference between a wrong answer and a read that never ends; the default is generous and the env is the knob.
 */
const TRAVERSE_PAGE_BOUND = 256

function traversePageBound(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.YRD_ISSUES_PAGE_BOUND?.trim()
  if (raw === undefined || raw === "") return TRAVERSE_PAGE_BOUND
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

type TraverseWalk = Readonly<{
  verb: IssuesVerb
  command: string
  declared: readonly string[]
  values: Readonly<Record<string, string>>
  runDeclared: (argv: readonly string[], command: string) => Promise<Readonly<{ ok: true; stdout: string }> | IssuesFailure>
  bound: number
}>

/**
 * Walk the provider's existing bounded pages as ONE read (@cto 8e7cbb99, @dev/3 7a95653e): every answer must
 * describe the same snapshot and journal head as the first, a change refuses the whole read rather than serving
 * two cuts, the page bound refuses instead of returning a partial set, and the result is one page-shaped answer
 * whose `next` is null. Callers that read a single page keep using `list-page`; nothing here restarts.
 */
async function traversePages(
  input: TraverseWalk,
): Promise<Readonly<{ ok: true; result: Record<string, unknown> }> | IssuesFailure> {
  const base = JSON.parse(input.values.page as string) as Record<string, unknown>
  let request: Record<string, unknown> = base
  let pageIndex = 1
  let rowsRead = 0
  let cursor: string | null = null
  let first: Record<string, unknown> | undefined
  const rows: unknown[] = []
  for (;;) {
    const ran = await input.runDeclared(
      substituteArgv(input.declared, { ...input.values, page: JSON.stringify(request) }),
      input.command,
    )
    if (!ran.ok) return ran
    let answer: unknown
    try {
      answer = JSON.parse(ran.stdout)
    } catch {
      return fail(
        1,
        ISSUES_CODES.providerNotJson,
        `${input.verb} ${input.command}`,
        `page ${pageIndex}: exit 0 but stdout is not JSON`,
      )
    }
    const page = answer as Record<string, unknown> | null
    if (page === null || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.rows)) {
      return fail(
        1,
        ISSUES_CODES.providerInvalidResult,
        `${input.verb} ${input.command}`,
        `page ${pageIndex} is not a page object with a rows array`,
      )
    }
    const pageRows = page.rows as unknown[]
    if (first === undefined) {
      first = page
    } else if (page.snapshot !== first.snapshot || page.head !== first.head) {
      const moved =
        page.snapshot !== first.snapshot
          ? `snapshot ${String(first.snapshot)} -> ${String(page.snapshot)}`
          : `head ${String(first.head)} -> ${String(page.head)}`
      return fail(
        1,
        ISSUES_CODES.pageSourceMoved,
        `${input.verb} ${input.command}`,
        `${moved} at page ${pageIndex} after ${rowsRead} rows (last cursor ${String(cursor)}); no rows served, read again for a fresh cut`,
      )
    }
    rows.push(...pageRows)
    rowsRead += pageRows.length
    if (page.complete === true) break
    const next = page.next
    if (typeof next !== "string" || next.length === 0) {
      return fail(
        1,
        ISSUES_CODES.providerInvalidResult,
        `${input.verb} ${input.command}`,
        `page ${pageIndex} is incomplete but names no next cursor`,
      )
    }
    if (pageIndex >= input.bound) {
      return fail(
        1,
        ISSUES_CODES.pageBound,
        `${input.verb} ${input.command}`,
        `stopped at the ${input.bound}-page bound after ${pageIndex} pages and ${rowsRead} rows (last cursor ${next}); no rows served`,
      )
    }
    cursor = next
    pageIndex += 1
    request = { ...base, page: next }
  }
  return { ok: true, result: { ...(first as Record<string, unknown>), rows, next: null, complete: true } }
}

/** Run one verb end to end and return the envelope or a named failure. Never throws for a provider's fault. */
export async function runIssuesVerb(options: RunIssuesVerbOptions): Promise<IssuesOutcome> {
  const request = checkRequest(options)
  if (!request.ok) return request
  const verb = options.verb as IssuesVerb
  const env = options.env ?? process.env
  const writeStderr = options.stderr ?? ((text: string) => void process.stderr.write(text))

  let root = options.projectRoot
  if (root === undefined) {
    const top = await git(["rev-parse", "--show-toplevel"], options.cwd, env)
    if (top.exitCode !== 0 || top.stdout === "") {
      return fail(1, ISSUES_CODES.notARepository, options.cwd, `not inside a git repository; ${top.stderr}`)
    }
    root = top.stdout
  } else if (!(await isRepositoryAt(root, env))) {
    return fail(1, ISSUES_CODES.notARepository, root, "--project-root is not the toplevel of a git repository")
  }
  const repository = await repositoryToRead(root, env)
  if (typeof repository !== "string") return repository

  let commit: string
  let text: string | undefined
  try {
    const reader = await openReader({ repo: repository, ref: "main", backend: createLegacyBackend("git", env) })
    commit = await reader.head()
    if (options.declarationCommit !== undefined) {
      await using ancestryProcess = createProcess({ cwd: repository, env: cleanGitEnvironment(env) })
      const selection = await resolveGitSelection(repository, { process: ancestryProcess, env })
      const ancestryGit = gitIn(repository, ancestryProcess, selection, { env })
      const pinned = (
        await ancestryGit(["rev-parse", "--verify", "--end-of-options", `${options.declarationCommit}^{commit}`])
      ).trim()
      const tip =
        options.targetCommit === undefined
          ? commit
          : (
              await ancestryGit(["rev-parse", "--verify", "--end-of-options", `${options.targetCommit}^{commit}`])
            ).trim()
      if (!(await isAncestor(ancestryGit, pinned, tip))) {
        return fail(
          1,
          ISSUES_CODES.noMain,
          repository,
          `declaration commit ${pinned} is not an ancestor of ${options.targetCommit === undefined ? "main" : "target"} ${tip}`,
        )
      }
      commit = pinned
    }
    text = await reader.at(commit).get(ISSUES_DECLARATION_PATH)
  } catch (error) {
    return fail(
      1,
      ISSUES_CODES.noMain,
      repository,
      `cannot read main: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const where = `${repository}@${commit}:${ISSUES_DECLARATION_PATH}`
  if (text === undefined) return fail(1, ISSUES_CODES.declarationMissing, where, "absent")

  let declaration: ReturnType<typeof parseIssuesDeclaration>
  try {
    declaration = parseIssuesDeclaration(text, where)
  } catch (error) {
    if (error instanceof IssuesDeclarationError) {
      return { ok: false, exitCode: 1, code: error.code, message: error.message }
    }
    throw error
  }
  const declared = declaration[verb]
  if (declared === undefined) {
    return fail(1, ISSUES_CODES.unsupported, verb, `${verb} is not declared in ${where} (unsupported)`)
  }

  const bound = verb === "traverse" ? traversePageBound(env) : undefined
  if (verb === "traverse" && bound === undefined) {
    return fail(
      2,
      ISSUES_CODES.badArguments,
      verb,
      `YRD_ISSUES_PAGE_BOUND must be a positive integer, found ${JSON.stringify(env.YRD_ISSUES_PAGE_BOUND)}`,
    )
  }

  if (verb === "assign") {
    for (const [key, flag] of [
      ["expected-owner", "--expected-owner"],
      ["requester", "--requested-by"],
    ] as const) {
      const token = `<${key}>`
      const advertised = declared.includes(token)
      const supplied = request.values[key] !== undefined
      if (advertised && !supplied) {
        return fail(2, ISSUES_CODES.badArguments, verb, `${where} declares ${token}; provide ${flag}`)
      }
      if (!advertised && supplied) {
        return fail(1, ISSUES_CODES.unsupported, verb, `${where} does not declare ${token} for ${flag}`)
      }
    }
  }

  /** Run one declared argv and hand back its stdout, or the named failure the caller reports. */
  const runDeclared = async (
    argv: readonly string[],
    command: string,
  ): Promise<Readonly<{ ok: true; stdout: string }> | IssuesFailure> => {
    const stopped = (): IssuesFailure =>
      fail(1, ISSUES_CODES.providerFailed, `${verb} ${command}`, `stopped: ${String(options.signal?.reason)}`)
    if (options.signal?.aborted) return stopped()
    const decoder = new TextDecoder()
    await using provider = createProcess({ cwd: options.cwd, env })
    let result: Awaited<ReturnType<typeof provider.run>>
    try {
      result = await provider.run({
        argv,
        cwd: options.cwd,
        env,
        signal: options.signal,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.noProgressTimeoutMs === undefined ? {} : { noProgressTimeoutMs: options.noProgressTimeoutMs }),
        onOutput: ({ stream, chunk }) => {
          if (stream === "stderr") writeStderr(decoder.decode(chunk, { stream: true }))
        },
      })
    } catch (error) {
      if (options.signal?.aborted) return stopped()
      if ((error as { code?: unknown } | null)?.code === "ENOENT") {
        return fail(
          1,
          ISSUES_CODES.providerMissing,
          `${verb} ${command}`,
          `command ${JSON.stringify(argv[0])} not found`,
        )
      }
      return fail(
        1,
        ISSUES_CODES.providerFailed,
        `${verb} ${command}`,
        `could not start: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (options.signal?.aborted) return stopped()
    if (result.timedOut) {
      return fail(1, ISSUES_CODES.providerTimedOut, `${verb} ${command}`, `killed after ${options.timeoutMs} ms`)
    }
    if (result.stalled === true) {
      return fail(
        1,
        ISSUES_CODES.providerStalled,
        `${verb} ${command}`,
        `no output for ${options.noProgressTimeoutMs} ms after ${result.lastProgressBytes} bytes; killed`,
      )
    }
    if (result.exitCode !== 0 || result.signal !== null) {
      const how = result.signal === null ? `exit ${result.exitCode}` : `signal ${result.signal}`
      return fail(1, ISSUES_CODES.providerFailed, `${verb} ${command}`, `provider ended with ${how}`)
    }
    if (result.outputTruncation !== undefined) {
      return fail(1, ISSUES_CODES.providerNotJson, `${verb} ${command}`, "exit 0 but stdout overflowed its capture")
    }
    return { ok: true, stdout: result.stdout }
  }

  const command = commandText(declared)
  let parsed: unknown
  if (verb === "traverse") {
    const walked = await traversePages({
      verb,
      command,
      declared,
      values: request.values,
      runDeclared,
      bound: bound ?? 0,
    })
    if (!walked.ok) return walked
    parsed = walked.result
  } else {
    const ran = await runDeclared(substituteArgv(declared, request.values), command)
    if (!ran.ok) return ran
    try {
      parsed = JSON.parse(ran.stdout)
    } catch {
      return fail(1, ISSUES_CODES.providerNotJson, `${verb} ${command}`, "exit 0 but stdout is not JSON")
    }
  }
  if (verb === "resolve") {
    const keys =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as { keys?: unknown }).keys
        : undefined
    if (
      !Array.isArray(keys) ||
      keys.length === 0 ||
      !keys.every((key) => typeof key === "string" && key.length > 0) ||
      new Set(keys).size !== keys.length
    ) {
      return fail(
        1,
        ISSUES_CODES.providerInvalidResult,
        `${verb} ${command}`,
        "exit 0 but expected {keys: [...]} with at least one nonempty string and no duplicate keys",
      )
    }
  }
  if (IN_PROGRESS_VERBS.has(verb) && options.environments !== undefined) {
    const readEnvironments = options.environments
    let holds: readonly IssuesEnvironmentHold[] | undefined
    try {
      holds = await readEnvironments({ root, cwd: options.cwd })
    } catch (error) {
      // The columns enrich a provider answer; they never gate reading one. An environment home that cannot be
      // located (an origin no network can answer, 25843) leaves the answer whole and says why on stderr, so a row
      // reader refuses an answer without columns instead of reading an absent column as false.
      writeStderr(
        `yrd issues ${verb}: in_progress columns unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
    if (holds !== undefined) {
      const now = Date.now()
      let activity: readonly IssuesActivityEvent[] | undefined
      const activityArgv = declaration.activity
      if (activityArgv !== undefined) {
        const activityCommand = commandText(activityArgv)
        try {
          const answered = await runDeclared(
            substituteArgv(activityArgv, { cutoff: String(now - OWNER_ACTIVITY_WINDOW_MS) }),
            activityCommand,
          )
          if (!answered.ok) throw new Error(answered.message)
          activity = readActivity(answered.stdout)
        } catch (error) {
          writeStderr(
            `yrd issues ${verb}: owner-activity columns unavailable: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          )
        }
      }
      // A declared source that failed leaves the columns unknown, never idle: an empty set would say "nobody
      // wrote", which is the one thing the failure did not establish (@cto 8e7cbb99).
      const activityUnknown = activityArgv !== undefined && activity === undefined
      const annotated = annotateInProgress(
        verb,
        parsed,
        activity === undefined ? { holds, ...(activityUnknown ? { activityUnknown } : {}) } : { holds, activity },
        now,
      )
      if (!annotated.ok) {
        return fail(
          1,
          annotated.fault === "environment" ? ISSUES_CODES.environmentUnreadable : ISSUES_CODES.providerInvalidResult,
          `${verb} ${command}`,
          annotated.detail,
        )
      }
      if (annotated.notice !== undefined) writeStderr(annotated.notice)
      parsed = annotated.result
      if (verb === "traverse" && annotated.unknownRows !== undefined) {
        parsed = { ...(parsed as Record<string, unknown>), activityUnreadRows: annotated.unknownRows }
      }
    }
  }
  return {
    ok: true,
    envelope: { declaration: { repository, commit, path: ISSUES_DECLARATION_PATH }, verb, result: parsed },
  }
}
