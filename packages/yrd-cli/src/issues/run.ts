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

export type IssuesEnvelope = Readonly<{
  declaration: Readonly<{ repository: string; commit: string; path: typeof ISSUES_DECLARATION_PATH }>
  verb: IssuesVerb
  result: unknown
}>

/** Exit 1: refused or failed with a named cause. Exit 2: the request itself is malformed. */
export type IssuesFailure = Readonly<{ ok: false; exitCode: 1 | 2; code: IssuesCode; message: string }>

export type IssuesOutcome = Readonly<{ ok: true; envelope: IssuesEnvelope }> | IssuesFailure

export type RunIssuesVerbOptions = Readonly<{
  verb: string
  /** The verb's positional operands, in {@link ISSUES_VERBS} order. */
  args: readonly string[]
  /** The replay key; required by every write verb. */
  id?: string
  /** The project root; absent, the toplevel of `cwd`'s repository. */
  projectRoot?: string
  /** Read this exact ancestor of main; automatic effects use their delivered merge commit. */
  declarationCommit?: string
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
}>

function fail(exitCode: 1 | 2, code: IssuesCode, subject: string, detail: string): IssuesFailure {
  return { ok: false, exitCode, code, message: `${code}: ${subject}: ${detail}` }
}

function commandText(argv: readonly string[]): string {
  return argv.map((word) => (word === "" || /[\s"'`$\\]/u.test(word) ? JSON.stringify(word) : word)).join(" ")
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
  if (verb === "close" && !(ISSUES_CLOSE_REASONS as readonly string[]).includes(values.reason as string)) {
    return fail(
      2,
      ISSUES_CODES.badArguments,
      `close ${JSON.stringify(values.reason)}`,
      `reason must be ${ISSUES_CLOSE_REASONS.join(" or ")}`,
    )
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
      if (!(await isAncestor(ancestryGit, pinned, commit))) {
        return fail(
          1,
          ISSUES_CODES.noMain,
          repository,
          `declaration commit ${pinned} is not an ancestor of main ${commit}`,
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

  let declared: readonly string[] | undefined
  try {
    declared = parseIssuesDeclaration(text, where)[verb]
  } catch (error) {
    if (error instanceof IssuesDeclarationError) {
      return { ok: false, exitCode: 1, code: error.code, message: error.message }
    }
    throw error
  }
  if (declared === undefined) {
    return fail(1, ISSUES_CODES.unsupported, verb, `${verb} is not declared in ${where} (unsupported)`)
  }

  const argv = substituteArgv(declared, request.values)
  const command = commandText(declared)
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
      return fail(1, ISSUES_CODES.providerMissing, `${verb} ${command}`, `command ${JSON.stringify(argv[0])} not found`)
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
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return fail(1, ISSUES_CODES.providerNotJson, `${verb} ${command}`, "exit 0 but stdout is not JSON")
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
  return {
    ok: true,
    envelope: { declaration: { repository, commit, path: ISSUES_DECLARATION_PATH }, verb, result: parsed },
  }
}
