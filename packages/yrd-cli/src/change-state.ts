/**
 * The branch-state verbs: a branch IS a change, and `draft` / `submit` /
 * `archive` / `ignore` move one INTO a state by pushing the decision ref the
 * receiver reads. There are no un-verbs — `draft` is how a branch is
 * unsubmitted or unshelved.
 *
 * THIS FILE OWNS SELECTION AND TRANSPORT, NEVER RULES. Which writes are legal,
 * how a branch is auto-classified at creation, when an ignore is refused
 * because a live submit stands — all of that lives in the receiver
 * (`@yrd/bay` receiver.ts) and is enforced there on every push, including
 * pushes this file knows nothing about. Restating any of it here would
 * produce a second copy that drifts from the one that actually decides, and
 * the operator would get a local refusal whose wording no longer matches the
 * server's. So: expand the selectors, say exactly what they resolved to, push,
 * and hand back the receiver's own words unaltered.
 */
import { readFileSync } from "node:fs"
import { Glob } from "bun"
import { raiseFailure } from "@yrd/core"
import { adaptProcessGit, gitFailure, type Process } from "@yrd/process"
import type { GitProcessResult } from "git-super/process"
import type { ChangeStateGitFacts, YrdCliExitCode, YrdCliIO } from "./types.ts"

const GIT_TIMEOUT_MS = 30_000

/** The four states a branch can be moved into. */
export type ChangeState = "draft" | "submit" | "archive" | "ignore"

/**
 * The scope/approval namespaces the receiver accepts a direct push to.
 * `archive` is deliberately absent: the shelf is permanent and refuses every
 * direct write ("written only by archiving a branch (deleting its refs/heads/
 * ref), never by a direct push" — receiver.ts). Archival is the receiver
 * translating a branch deletion, so {@link refspecsFor} pushes one.
 */
const DECISION_REF_PREFIX = {
  draft: "refs/yrd/draft/",
  submit: "refs/yrd/submit/",
  ignore: "refs/yrd/ignore/",
} as const satisfies Record<Exclude<ChangeState, "archive">, string>

const SUBMIT_REF_PREFIX = DECISION_REF_PREFIX.submit

/**
 * Branches Yrd itself owns. A bare invocation on one of these is refused
 * rather than guessed at, and a glob never sweeps one in: an operator asking
 * for `task/*` never means the queue's own carrier refs, and a verb that
 * archived one would delete queue state as a side effect of a typo.
 */
const INTERNAL_BRANCH_PREFIX = "yrd/"

const GLOB_CHARACTERS = /[*?[\]{}]/u

function isGlob(selector: string): boolean {
  return GLOB_CHARACTERS.test(selector)
}

/**
 * The branches a selector list names, sorted and de-duplicated.
 *
 * A glob that matches nothing is a REFUSAL, not an empty success. The two
 * cases look identical in a filter ("no rows matched, that is the answer") and
 * opposite in an action: an action with no target did not happen, and
 * reporting it as done is the silent success this whole surface exists to
 * prevent. So the pattern is named back to the operator.
 */
export function resolveBranchSelection(
  selectors: readonly string[],
  branches: readonly string[],
  current: string | undefined,
): string[] {
  if (selectors.length === 0) {
    if (current === undefined || current === "") {
      raiseFailure(
        "refusal",
        "change-state-no-branch",
        "yrd: no current Git branch to act on; name one or more branches or globs",
      )
    }
    if (current.startsWith(INTERNAL_BRANCH_PREFIX)) {
      raiseFailure(
        "refusal",
        "change-state-internal-branch",
        `yrd: the current branch '${current}' is Yrd's own queue state, not a change; ` +
          "name the branch you mean explicitly",
      )
    }
    return [current]
  }

  const selectable = branches.filter((branch) => !branch.startsWith(INTERNAL_BRANCH_PREFIX))
  const selected = new Set<string>()
  for (const selector of selectors) {
    if (isGlob(selector)) {
      const matcher = new Glob(selector)
      const matches = selectable.filter((branch) => matcher.match(branch))
      if (matches.length === 0) {
        raiseFailure(
          "refusal",
          "change-state-glob-matched-nothing",
          `yrd: the pattern '${selector}' matched no branch; nothing was pushed`,
        )
      }
      for (const branch of matches) selected.add(branch)
      continue
    }
    if (!branches.includes(selector)) {
      raiseFailure(
        "refusal",
        "change-state-unknown-branch",
        `yrd: there is no branch '${selector}' here; nothing was pushed`,
      )
    }
    selected.add(selector)
  }
  return [...selected].sort()
}

/**
 * The refspecs one state costs, in the order they are pushed.
 *
 * `draft` is also the unsubmit: a branch that carries a live submit ref has
 * that approval withdrawn in the same atomic push. The deletion is included
 * ONLY when the ref actually exists, because git fails a delete of a ref that
 * does not — which would make `yrd draft` unusable on the ordinary branch that
 * was never submitted.
 */
export function refspecsFor(
  state: ChangeState,
  branches: readonly string[],
  liveSubmitRef: (ref: string) => boolean,
): string[] {
  if (state === "archive") return branches.map((branch) => `:refs/heads/${branch}`)
  const prefix = DECISION_REF_PREFIX[state]
  return branches.flatMap((branch) => {
    const write = `${branch}:${prefix}${branch}`
    if (state !== "draft") return [write]
    return liveSubmitRef(`${SUBMIT_REF_PREFIX}${branch}`) ? [write, `:${SUBMIT_REF_PREFIX}${branch}`] : [write]
  })
}

/** What the verb will do, in the words the operator can re-run by hand. */
export function renderPlan(state: ChangeState, branches: readonly string[], command: readonly string[]): string {
  const heading = `${state}: ${branches.length} ${branches.length === 1 ? "branch" : "branches"}`
  return [heading, ...branches.map((branch) => `  ${branch}`), command.join(" "), ""].join("\n")
}

export type ChangeStateOptions = Readonly<{
  dryRun?: boolean
  message?: string
  messageFile?: string
}>

/**
 * Resolve `-m` / `-F <file>` / `-F -` into the archive message, git-style.
 * The two are mutually exclusive, exactly as `git commit` treats them.
 */
function archiveMessage(options: ChangeStateOptions, readFile: (path: string) => string): string | undefined {
  if (options.message !== undefined && options.messageFile !== undefined) {
    raiseFailure("usage", "change-state-message-conflict", "yrd: pass either -m or -F, not both")
  }
  if (options.message !== undefined) return options.message
  if (options.messageFile === undefined) return undefined
  const text = readFile(options.messageFile === "-" ? "/dev/stdin" : options.messageFile)
  return text.trim() === "" ? undefined : text.trim()
}

export type ChangeStateDeps = Readonly<{
  git: ChangeStateGitFacts
  readFile: (path: string) => string
  /**
   * The branch a bare invocation targets.
   *
   * REQUIRED, not optional, and that is the whole point. This read used to go
   * straight to `io.currentBranch`, which only tests set: every injected test
   * passed while `yrd draft` in a real repository refused with "no current
   * Git branch to act on". Making the supplier mandatory means the caller
   * cannot forget to pass the CLI's one real resolver, so the seam and
   * reality cannot drift apart again.
   */
  currentBranch: () => string | undefined
}>

/** Move every selected branch into `state`. */
export async function applyChangeState(
  state: ChangeState,
  selectors: readonly string[],
  options: ChangeStateOptions,
  io: YrdCliIO,
  deps: ChangeStateDeps,
): Promise<YrdCliExitCode> {
  const message = state === "archive" ? archiveMessage(options, deps.readFile) : undefined
  if (message !== undefined && state !== "archive") {
    raiseFailure("usage", "change-state-message-unsupported", `yrd: ${state} takes no message`)
  }

  const branches = resolveBranchSelection(selectors, await deps.git.branches(), deps.currentBranch())

  // Only `draft` needs to know whether an approval stands, and only then is
  // the remote round-trip worth paying for.
  const liveSubmits = new Set<string>()
  if (state === "draft") {
    for (const branch of branches) {
      const ref = `${SUBMIT_REF_PREFIX}${branch}`
      if ((await deps.git.remoteRef(ref)) !== undefined) liveSubmits.add(ref)
    }
  }

  const refspecs = refspecsFor(state, branches, (ref) => liveSubmits.has(ref))
  // `--atomic` so a batch is all-or-nothing: a glob over twenty branches that
  // the receiver refuses on one must not leave the other nineteen moved.
  const args = ["push", "--atomic", "origin", ...refspecs]
  io.stdout(renderPlan(state, branches, ["git", ...args]))

  if (message !== undefined) {
    // NO SILENT ERRORS: the receiver has no message channel at all — no
    // GIT_PUSH_OPTION handling anywhere in packages/, and `applyArchival`
    // takes no message — so this text reaches nobody. Say so; do not invent a
    // store for it, and do not accept it in silence.
    io.stderr(
      "yrd: archive message not transmitted — the receiver has no message channel yet, " +
        `so this text is recorded nowhere:\n  ${message}\n`,
    )
  }

  if (options.dryRun === true) return 0

  const result = await deps.git.push(args)
  if (!result.ok) {
    // The receiver's own words, unaltered. A paraphrase here loses the one
    // instruction that says what to do next.
    io.stderr(result.output.endsWith("\n") ? result.output : `${result.output}\n`)
    return 1
  }
  if (result.output !== "") io.stderr(result.output.endsWith("\n") ? result.output : `${result.output}\n`)
  return 0
}

function transportFailed(result: GitProcessResult): boolean {
  return result.timedOut === true || result.failure !== undefined
}

/** Real Git plumbing for the branch-state verbs. */
export function createChangeStateGitFacts(cwd: string, process: Pick<Process, "run">): ChangeStateGitFacts {
  const git = adaptProcessGit(process, { timeoutMs: GIT_TIMEOUT_MS })
  const run = (args: readonly string[]) => git.run({ repo: cwd, args })
  return {
    branches: async () => {
      const listed = await run(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      if (listed.code !== 0 || transportFailed(listed)) {
        raiseFailure(
          "infrastructure",
          "change-state-branches-unreadable",
          `yrd: could not list branches in '${cwd}': ${gitFailure(listed, GIT_TIMEOUT_MS)}`,
        )
      }
      return listed.stdout.split("\n").filter((line) => line !== "")
    },
    remoteRef: async (ref) => {
      const listed = await run(["ls-remote", "origin", ref])
      if (listed.code !== 0 || transportFailed(listed)) {
        // Canonical transport-read code (registered in YRD_REFUSAL_CODES);
        // the old "change-state-remote-unreadable" spelling survives as its
        // registered alias for recorded data.
        raiseFailure(
          "infrastructure",
          "transport-read-failed",
          `yrd: could not read '${ref}' from origin: ${gitFailure(listed, GIT_TIMEOUT_MS)}`,
        )
      }
      const sha = listed.stdout.split("\t")[0]?.trim()
      return sha === undefined || sha === "" ? undefined : sha
    },
    // A rejected push is the receiver speaking, not a broken tool: its words
    // are the result, and the caller prints them unaltered.
    push: async (args) => {
      const pushed = await run(args)
      if (transportFailed(pushed)) {
        raiseFailure(
          "infrastructure",
          "change-state-push-unavailable",
          `yrd: could not run the branch-state push in '${cwd}': ${gitFailure(pushed, GIT_TIMEOUT_MS)}`,
        )
      }
      return { ok: pushed.code === 0, output: `${pushed.stderr}${pushed.stdout}` }
    },
  }
}

/** The dependencies a verb runs against, defaulting to real Git in `cwd`. */
export function changeStateDeps(
  io: YrdCliIO,
  currentBranch: () => string | undefined,
  gitProcess?: Pick<Process, "run">,
): ChangeStateDeps {
  const cwd = io.cwd ?? globalThis.process.cwd()
  let git = io.changeStateGit?.(cwd)
  if (git === undefined) {
    if (gitProcess === undefined) {
      raiseFailure(
        "configuration",
        "change-state-process-missing",
        "yrd: branch-state transport requires the shared process runtime",
      )
      throw new Error("raiseFailure returned without throwing")
    }
    git = createChangeStateGitFacts(cwd, gitProcess)
  }
  return {
    git,
    readFile: (path) => readFileSync(path, "utf8"),
    currentBranch,
  }
}
