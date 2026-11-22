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

/**
 * A read answers one envelope. A `list-page` traversal answers one envelope PER PAGE in {@link stream} — the same
 * page envelope the deployed reader decodes, one compact JSON object per line — and `envelope` is the first page,
 * so every caller that reads a single answer keeps working unchanged.
 */
export type IssuesOutcome =
  | Readonly<{ ok: true; envelope: IssuesEnvelope; stream?: readonly IssuesEnvelope[] }>
  | IssuesFailure

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
const IN_PROGRESS_VERBS: ReadonlySet<string> = new Set(["view", "list-page", "list"])

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
 * #37838 (@cto ead63117): how many provider pages ONE `list-page` traversal may read before it refuses. A page
 * limit is the difference between a wrong answer and a read that never ends: the 256th COMPLETE page answers, an
 * incomplete 256th refuses. It is internal on purpose — a per-project knob would be a second contract for a bound
 * the Workboard does not get to choose.
 */
const LIST_PAGE_TRAVERSE_BOUND = 256

type ListPageRead = Readonly<{
  verb: IssuesVerb
  command: string
  declared: readonly string[]
  values: Readonly<Record<string, string>>
  runDeclared: (
    argv: readonly string[],
    command: string,
  ) => Promise<Readonly<{ ok: true; stdout: string }> | IssuesFailure>
  bound: number
}>

/**
 * Read every page of ONE `list-page` request that opts in with `traverse:true` (@cto ead63117, e1873f39). The
 * provider's own `list-page` argv runs ONCE; every page it streams must describe the same snapshot, journal head,
 * generation and population as the first, a change refuses the whole read rather than serving two cuts, the page
 * bound refuses instead of returning a partial set, and the terminal page must say `complete:true` with a count
 * matching the rows read. Ordinary callers that do not opt in never reach here and get one page, byte for byte.
 *
 * ONE PROCESS, not a token loop. Measured on /hh/pm 2026-11-22: a loop that re-invokes the provider per token
 * read 10 pages in 124 s and then refused — the vault landed, and a token names one revision, so the next
 * continuation was no longer that checkout's tree. One provider process streaming from one loaded snapshot read
 * 22,224 rows in 23 pages in 71 s; a provider that answers one page in one JSON object still works unchanged.
 */
async function readListPages(
  input: ListPageRead,
): Promise<Readonly<{ ok: true; pages: readonly (Record<string, unknown> & { rows: unknown[] })[] }> | IssuesFailure> {
  const ran = await input.runDeclared(substituteArgv(input.declared, input.values), input.command)
  if (!ran.ok) return ran
  const pages = readPageStream(ran.stdout, input.verb, input.command)
  if (!("pages" in pages)) return pages
  let pageIndex = 1
  let rowsRead = 0
  let cursor: string | null = null
  let first: Record<string, unknown> | undefined
  const kept: (Record<string, unknown> & { rows: unknown[] })[] = []
  let complete = false
  for (const page of pages.pages) {
    if (first === undefined) {
      first = page
    } else {
      const moved =
        page.snapshot !== first.snapshot
          ? `snapshot ${String(first.snapshot)} -> ${String(page.snapshot)}`
          : page.head !== first.head
            ? `head ${String(first.head)} -> ${String(page.head)}`
            : page.generation !== first.generation
              ? `generation ${String(first.generation)} -> ${String(page.generation)}`
              : page.population !== first.population
                ? `population ${String(first.population)} -> ${String(page.population)}`
                : undefined
      if (moved !== undefined) {
        return fail(
          1,
          ISSUES_CODES.pageSourceMoved,
          `${input.verb} ${input.command}`,
          `${moved} at page ${pageIndex} after ${rowsRead} rows (last cursor ${String(cursor)}); no rows served, read again for a fresh cut`,
        )
      }
    }
    kept.push(page)
    rowsRead += page.rows.length
    if (page.complete === true) {
      complete = true
      break
    }
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
  }
  if (!complete) {
    return fail(
      1,
      ISSUES_CODES.providerInvalidResult,
      `${input.verb} ${input.command}`,
      `the last page (${pageIndex}) is incomplete and the provider sent no page after it; no rows served`,
    )
  }
  const last = kept[kept.length - 1] as Record<string, unknown>
  if (typeof last.population === "number" && last.population !== rowsRead) {
    return fail(
      1,
      ISSUES_CODES.providerInvalidResult,
      `${input.verb} ${input.command}`,
      `the pages read ${rowsRead} rows but the terminal page declares population ${last.population}; no rows served`,
    )
  }
  kept[kept.length - 1] = { ...last, next: null, complete: true, rows: last.rows as unknown[] }
  return { ok: true, pages: kept }
}

/**
 * The provider's stdout as page documents: one JSON object (a single-page answer) or one compact JSON object per
 * line (a streaming traversal). Anything else is refused by name rather than guessed at.
 */
function readPageStream(
  stdout: string,
  verb: IssuesVerb,
  command: string,
): Readonly<{ pages: readonly (Record<string, unknown> & { rows: unknown[] })[] }> | IssuesFailure {
  const invalid = (detail: string): IssuesFailure =>
    fail(1, ISSUES_CODES.providerInvalidResult, `${verb} ${command}`, detail)
  const asPage = (
    value: unknown,
    index: number,
  ): Readonly<{ page: Record<string, unknown> & { rows: unknown[] } }> | Readonly<{ failure: IssuesFailure }> => {
    const page = value as Record<string, unknown> | null
    if (page === null || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.rows)) {
      return { failure: invalid(`page ${index} is not a page object with a rows array`) }
    }
    return { page: page as Record<string, unknown> & { rows: unknown[] } }
  }
  const text = stdout.trim()
  if (text === "") return fail(1, ISSUES_CODES.providerNotJson, `${verb} ${command}`, "exit 0 but stdout is empty")
  try {
    const whole = asPage(JSON.parse(text), 1)
    return "failure" in whole ? whole.failure : { pages: [whole.page] }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  const pages: (Record<string, unknown> & { rows: unknown[] })[] = []
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return fail(
        1,
        ISSUES_CODES.providerNotJson,
        `${verb} ${command}`,
        `document ${index + 1} is not JSON and the whole answer is not one JSON object`,
      )
    }
    const document = asPage(value, pages.length + 1)
    if ("failure" in document) return document.failure
    pages.push(document.page)
  }
  if (pages.length === 0) return fail(1, ISSUES_CODES.providerNotJson, `${verb} ${command}`, "no page documents")
  return { pages }
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
  let streamedPages: Record<string, unknown>[] | undefined
  if (verb === "list-page" && pageRequestTraversal(request.values.page)) {
    const read = await readListPages({
      verb,
      command,
      declared,
      values: request.values,
      runDeclared,
      bound: LIST_PAGE_TRAVERSE_BOUND,
    })
    if (!read.ok) return read
    streamedPages = read.pages.map((page) => ({ ...page }))
    parsed = streamedPages[0]
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
      const inputs =
        activity === undefined ? { holds, ...(activityUnknown ? { activityUnknown } : {}) } : { holds, activity }
      const annotateOne = (
        page: unknown,
      ): IssuesFailure | Readonly<{ ok: true; page: unknown; unknownRows?: number }> => {
        const annotated = annotateInProgress(verb, page, inputs, now)
        if (!annotated.ok) {
          return fail(
            1,
            annotated.fault === "environment" ? ISSUES_CODES.environmentUnreadable : ISSUES_CODES.providerInvalidResult,
            `${verb} ${command}`,
            annotated.detail,
          )
        }
        if (annotated.notice !== undefined) writeStderr(annotated.notice)
        return { ok: true, page: annotated.result, unknownRows: annotated.unknownRows }
      }
      if (streamedPages !== undefined) {
        // ONE capture for the whole refresh: every page is annotated from the same holds and activity read.
        const annotated: Record<string, unknown>[] = []
        let unknownRows = 0
        for (const page of streamedPages) {
          const one = annotateOne(page)
          if (!one.ok) return one
          unknownRows += one.unknownRows ?? 0
          annotated.push(one.page as Record<string, unknown>)
        }
        // Stated ONCE, on the terminal line: a clean refresh and an all-unknown one answer the same shape (0 vs a
        // real count), and no page can leave a row that reads idle when the read that would have said otherwise
        // failed (#37838).
        const last = annotated[annotated.length - 1] as Record<string, unknown>
        const meta = isPlainObject(last.meta) ? (last.meta as Record<string, unknown>) : {}
        annotated[annotated.length - 1] = { ...last, meta: { ...meta, activityUnreadRows: unknownRows } }
        streamedPages = annotated
        parsed = annotated[0]
      } else {
        const one = annotateOne(parsed)
        if (!one.ok) return one
        parsed = one.page
      }
    }
  }
  const pin = { repository, commit, path: ISSUES_DECLARATION_PATH } as const
  if (streamedPages !== undefined) {
    const envelopes: IssuesEnvelope[] = streamedPages.map((page) => ({ declaration: pin, verb, result: page }))
    const head = envelopes[0]
    if (head === undefined) {
      // The walk refuses an empty answer before it returns, so this is a broken invariant, not a provider's answer.
      return fail(1, ISSUES_CODES.providerInvalidResult, `${verb} ${command}`, "the traversal read no page")
    }
    return { ok: true, envelope: head, stream: envelopes }
  }
  return { ok: true, envelope: { declaration: pin, verb, result: parsed } }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * #37838 (@cto e1873f39): a `list-page` request opts into one-process traversal by saying `traverse:true` inside
 * its own `<page>` JSON — no second verb, no new declaration key. `checkRequest` has already refused a `<page>`
 * that is not a JSON object; anything else here is an ordinary one-page call and stays byte-identical.
 */
function pageRequestTraversal(page: string | undefined): boolean {
  if (page === undefined) return false
  try {
    const request: unknown = JSON.parse(page)
    return isPlainObject(request) && request.traverse === true
  } catch {
    return false
  }
}
