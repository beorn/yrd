import { stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { Process, ProcessResult } from "@yrd/process"
import type { PinIntentAdmission, PinTombstone, RemedyStepV1 } from "@yrd/intent"
import { cleanGitEnvironment } from "./git-environment.ts"

export type { PinIntentAdmission, PinIntentAdmitted, PinIntentRefused, PinIntentRelation } from "@yrd/intent"

const GIT_TIMEOUT_MS = 30_000

/**
 * How the declared target sits relative to the pin the base branch carries.
 *
 * `deferred` is the no-target form: the queue derives the component's main tip
 * at landing, so there is nothing to relate yet.
 */
export type PinIntentAdmissionOptions = Readonly<{
  process: Pick<Process, "run">
  repo: string
  base: string
  component: string
  /** Runnable issue argument preserved in every intent resubmission remedy. */
  issue: string
  target?: string
  expectedCurrentPin?: string
  tombstones?: readonly Pick<PinTombstone, "sha">[]
  /** Merge-time authority derives an omitted target from component main. */
  deriveTarget?: boolean
  /**
   * Waive the trunk-reachability gate for a deliberate off-trunk pin. The
   * submitter declares it and the intent record carries the declaration; this
   * flag is the only way past {@link admitPinIntent}'s trunk check.
   */
  allowOffTrunk?: boolean
}>

/**
 * Advisory admission for a pin-advance intent.
 *
 * Advisory because main moves: merge-time evaluation is the only authority, and
 * this deliberately re-runs there. Admission exists so the submitter gets a
 * loud, actionable failure while their context is still warm — the same split
 * as Candidate mergeability today.
 *
 * Every refusal carries typed {@link RemedyStepV1} steps. The printed sentence
 * is rendered from those steps, never parsed back out of prose.
 */
export async function admitPinIntent(options: PinIntentAdmissionOptions): Promise<PinIntentAdmission> {
  const repo = resolve(options.repo)
  const gitlinks = await baseGitlinks(options.process, repo, options.base)
  const currentPin = gitlinks.get(options.component)
  if (currentPin === undefined) {
    return {
      admitted: false,
      code: "intent-component-unknown",
      message: `yrd: '${options.component}' is not a declared component on '${options.base}'`,
      evidence: { component: options.component, declared: [...gitlinks.keys()] },
      remedy: [...gitlinks.keys()].map((declared) => ({
        argv: [
          "yrd",
          "intent",
          "submit",
          "--component",
          declared,
          ...(options.target === undefined ? [] : ["--target", options.target]),
          "--issue",
          options.issue,
        ],
        note: `declared component on ${options.base}`,
      })),
    }
  }

  const componentRepo = resolve(repo, options.component)
  const branch = await componentBranch(options.process, repo, options.component)
  /**
   * The refresh, and whether it worked.
   *
   * Every publication answer below is read from this checkout's own
   * remote-tracking refs, so a fetch that failed turns all of them into stale
   * reads. Discarding the outcome — what this line used to do — let a failed
   * refresh masquerade as a clean negative and refused commits that were the
   * component's published tip. The outcome is now carried into the verdict.
   */
  const fetched = await fetchComponent(options.process, componentRepo)
  const scope: PublicationScope = {
    repo: componentRepo,
    refs: "refs/remotes/origin/*",
    fetched,
    lastFetchAt: await lastFetchAt(options.process, componentRepo),
  }
  /**
   * The component's trunk tip, read from the remote-tracking ref the fetch
   * above just refreshed — the same snapshot the derived target comes from, so
   * the two can never disagree about what trunk is.
   *
   * Freshness caveat: trunk moves. This read is as advisory as the rest of
   * admission, which is why merge-time evaluation re-runs it (`deriveTarget`)
   * and is the only authority.
   */
  const trunk = (
    await tryGit(options.process, componentRepo, ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`])
  )?.trim()
  const derivedTarget = options.deriveTarget === true ? trunk : undefined
  const target = options.target ?? derivedTarget
  if (target === undefined && options.deriveTarget !== true) {
    return { admitted: true, currentPin, relation: "deferred" }
  }
  if (target === undefined) {
    return {
      admitted: false,
      code: "intent-target-unpublished",
      message:
        `yrd: component '${options.component}' has no published origin/${branch} tip to derive; whoever holds ` +
        `the local commit must publish it through that component's own git workflow before an intent can be evaluated. ` +
        scopeSentence(scope),
      evidence: { component: options.component, currentPin, ...scopeEvidence(scope) },
      remedy: [
        ...(fetched.ok ? [] : [retryStep(options.component, undefined, options.issue)]),
        {
          argv: ["yrd", "intent", "submit", "--component", options.component, "--issue", options.issue],
          note: "resubmit once the component's local commit is published; the queue re-derives the trunk tip at merge time",
        },
      ],
    }
  }
  if (options.expectedCurrentPin !== undefined && options.expectedCurrentPin !== currentPin) {
    return {
      admitted: false,
      code: "intent-pin-moved",
      message: `yrd: intent expected pin '${options.expectedCurrentPin}', but '${options.component}' is pinned at '${currentPin}'`,
      evidence: { component: options.component, target, currentPin },
      remedy: [
        {
          argv: [
            "yrd",
            "intent",
            "submit",
            "--component",
            options.component,
            "--target",
            target,
            "--issue",
            options.issue,
          ],
          note: "resubmit against the current pin or omit the expected-pin guard",
        },
      ],
    }
  }
  const publication = await readPublication(options.process, componentRepo, target)
  if (!publication.published) {
    return {
      admitted: false,
      code: "intent-target-unpublished",
      message:
        `yrd: target '${target}' is not reachable from any published branch of '${options.component}'; whoever ` +
        `holds it must publish it through that component's own git workflow before it can be admitted. ` +
        `${PUBLICATION_REASON_CLAUSE[publication.reason]}. ${scopeSentence(scope)}`,
      evidence: {
        component: options.component,
        target,
        currentPin,
        ...scopeEvidence(scope),
        publicationReason: publication.reason,
      },
      remedy: [
        ...(fetched.ok ? [] : [retryStep(options.component, target, options.issue)]),
        {
          argv: [
            "yrd",
            "intent",
            "submit",
            "--component",
            options.component,
            "--target",
            target,
            "--issue",
            options.issue,
          ],
          note: "resubmit once the target is published",
        },
      ],
    }
  }

  for (const tombstone of options.tombstones ?? []) {
    if (!(await isAncestor(options.process, componentRepo, tombstone.sha, target))) continue
    return {
      admitted: false,
      code: "intent-target-tombstoned",
      message:
        `yrd: target '${target}' descends from rolled-back pin '${tombstone.sha}' of '${options.component}'; ` +
        `revert the tombstoned change and publish the safe descendant through the component's own git workflow ` +
        `before submitting a new intent`,
      evidence: { component: options.component, target, currentPin, tombstone: tombstone.sha },
      remedy: [
        {
          argv: ["git", "revert", tombstone.sha],
          cwd: options.component,
          note: "revert the tombstoned component change on the intended lineage",
        },
        {
          argv: [
            "yrd",
            "intent",
            "submit",
            "--component",
            options.component,
            "--target",
            "<safe-sha>",
            "--issue",
            options.issue,
          ],
          note: "submit a target that does not descend from the rolled-back pin",
        },
      ],
    }
  }

  if (await isAncestor(options.process, componentRepo, currentPin, target)) {
    // Descending from the pin is not the same as being on the component's own
    // line. A target can descend, be published, and still sit on a branch trunk
    // never took — and because a pin advance is a pointer move, everything only
    // on the line trunk DID take vanishes with no diff for anyone to read. The
    // waiver is declared, never inferred.
    if (options.allowOffTrunk !== true && !(await isTrunkReachable(options.process, componentRepo, trunk, target))) {
      return offTrunkRefusal(options.component, target, currentPin, trunk, options.issue, scope)
    }
    return { admitted: true, currentPin, target, relation: "advance" }
  }
  if (await isAncestor(options.process, componentRepo, target, currentPin)) {
    // Already contained. Admitted, not refused: evaluation concludes `noop`,
    // which is terminal SUCCESS with a receipt, not a failure.
    return { admitted: true, currentPin, target, relation: "noop" }
  }

  return {
    admitted: false,
    code: "intent-pin-divergent",
    message:
      `yrd: target '${target}' and the current pin '${currentPin}' of '${options.component}' have no ancestry; ` +
      `merge inside the component and publish the merge through the component's own git workflow before ` +
      `submitting a new intent`,
    evidence: { component: options.component, target, currentPin },
    remedy: [
      {
        argv: ["git", "merge", currentPin],
        cwd: options.component,
        note: "merge inside the component, where merges belong",
      },
      {
        argv: [
          "yrd",
          "intent",
          "submit",
          "--component",
          options.component,
          "--target",
          "<merge-sha>",
          "--issue",
          options.issue,
        ],
        note: "submit a NEW intent with the merge sha; it supersedes this one by key",
      },
    ],
  }
}

/**
 * Is the target an ancestor-or-equal of the component's trunk tip?
 *
 * An absent trunk answers NO, never yes: a component with no published trunk
 * has nothing for the target to be reachable from, and admitting on a read that
 * failed is the silent-error shape this check exists to close.
 */
async function isTrunkReachable(
  process: Pick<Process, "run">,
  componentRepo: string,
  trunk: string | undefined,
  target: string,
): Promise<boolean> {
  if (trunk === undefined) return false
  return trunk === target || (await isAncestor(process, componentRepo, target, trunk))
}

/**
 * The refusal, with a remedy that stays on the pipeline.
 *
 * Neither step is a hand-write to a component ref: landing the off-trunk line
 * on trunk is the component's own landing path, and the remedy a submitter can
 * execute is choosing a trunk-reachable target or declaring the pin deliberate.
 */
function offTrunkRefusal(
  component: string,
  target: string,
  currentPin: string,
  trunk: string | undefined,
  issue: string,
  scope: PublicationScope,
): PinIntentAdmission {
  const trunkClause =
    trunk === undefined
      ? `'${component}' has no published trunk tip to be reachable from`
      : `the trunk tip of '${component}' is '${trunk}'`
  return {
    admitted: false,
    code: "intent-target-off-trunk",
    message: `yrd: target '${target}' is not on the trunk of '${component}'; ${trunkClause}. ${scopeSentence(scope)}`,
    evidence: {
      component,
      target,
      currentPin,
      ...(trunk === undefined ? {} : { trunk }),
      ...scopeEvidence(scope),
    },
    remedy: [
      ...(trunk === undefined
        ? []
        : [
            {
              argv: ["yrd", "intent", "submit", "--component", component, "--target", trunk, "--issue", issue],
              note: "advance to the trunk tip; land the off-trunk line on trunk through the component's own landing path first if its content is wanted",
            },
          ]),
      {
        argv: [
          "yrd",
          "intent",
          "submit",
          "--component",
          component,
          "--target",
          target,
          "--issue",
          issue,
          "--allow-off-trunk",
        ],
        note: "declare a deliberate off-trunk pin; the declaration is recorded on the intent",
      },
    ],
  }
}

/** Every gitlink declared on the base branch, path -> pin. */
async function baseGitlinks(
  process: Pick<Process, "run">,
  repo: string,
  base: string,
): Promise<ReadonlyMap<string, string>> {
  const raw = await git(process, repo, ["ls-tree", "-r", "-z", base])
  const gitlinks = new Map<string, string>()
  for (const entry of raw.split("\0")) {
    if (entry === "") continue
    const [meta, path] = entry.split("\t")
    if (meta === undefined || path === undefined) {
      throw new Error(`yrd: git ls-tree returned an invalid entry: ${entry}`)
    }
    const [mode, , sha] = meta.split(" ")
    if (mode === "160000" && sha !== undefined) gitlinks.set(path, sha)
  }
  return gitlinks
}

/**
 * The component's tracked branch from `.gitmodules`, defaulting to `main`.
 *
 * This is the branch a publication remedy pushes to, so a wrong answer makes
 * the remedy wrong — which is exactly the defect class typed remedies exist to
 * kill. Read it, never assume it.
 */
async function componentBranch(process: Pick<Process, "run">, repo: string, component: string): Promise<string> {
  const configured = await tryGit(process, repo, [
    "config",
    "-f",
    ".gitmodules",
    "--get",
    `submodule.${component}.branch`,
  ])
  const branch = configured?.trim()
  return branch === undefined || branch === "" || branch === "." ? "main" : branch
}

/**
 * Why a target looked unpublished — the three states a boolean used to merge.
 *
 * `commit-absent` is the checkout never having seen the commit, which a failed
 * fetch alone can cause; `no-containing-ref` is the real unpublished shape; and
 * `read-failed` is admission not knowing. Printing any of them as the second
 * one is what refused published commits, so they stay apart all the way to the
 * message.
 */
type PublicationRead = Readonly<
  { published: true } | { published: false; reason: "commit-absent" | "no-containing-ref" | "read-failed" }
>

const PUBLICATION_REASON_CLAUSE: Readonly<Record<"commit-absent" | "no-containing-ref" | "read-failed", string>> = {
  "commit-absent": "The target commit is not present in that checkout at all",
  "no-containing-ref": "The target commit is present in that checkout, but no remote-tracking ref contains it",
  "read-failed": "The containing-ref read itself failed, so publication is unknown rather than disproved",
}

/** Did the refreshing fetch run, and if not, why not. */
type FetchOutcome = Readonly<{ ok: true } | { ok: false; detail: string }>

/** Everything a reader needs to judge the publication answer's authority. */
type PublicationScope = Readonly<{
  repo: string
  refs: string
  fetched: FetchOutcome
  lastFetchAt: LastFetch
}>

type LastFetch = Readonly<{ known: true; at: string } | { known: false; why: string }>

/**
 * Refresh the component's remote-tracking refs, reporting failure instead of
 * throwing.
 *
 * A fetch that cannot run must not abort admission — the local refs still
 * support an advisory answer — but it must never pass silently either, so the
 * failure travels back as a value the refusal is obliged to disclose. A timeout
 * is a failure like any other here, not an exception.
 */
async function fetchComponent(process: Pick<Process, "run">, componentRepo: string): Promise<FetchOutcome> {
  const result = await run(process, componentRepo, ["fetch", "--quiet", "--prune", "origin"])
  if (result.timedOut) return { ok: false, detail: `timed out after ${GIT_TIMEOUT_MS}ms` }
  if (result.exitCode === 0) return { ok: true }
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
  return { ok: false, detail: detail.replaceAll("\n", " ") }
}

/**
 * When this checkout last fetched, from FETCH_HEAD's mtime.
 *
 * Recency is the half of "as of when" that the fetch outcome cannot supply: a
 * fetch that just failed leaves the previous timestamp standing, and that
 * timestamp is how a reader judges the staleness they are being handed. An
 * unreadable FETCH_HEAD answers with the reason, never with silence.
 */
async function lastFetchAt(process: Pick<Process, "run">, componentRepo: string): Promise<LastFetch> {
  const gitDir = (await tryGit(process, componentRepo, ["rev-parse", "--absolute-git-dir"]))?.trim()
  if (gitDir === undefined || gitDir === "") {
    return { known: false, why: "unknown (the component checkout has no readable git dir)" }
  }
  try {
    const stats = await stat(join(gitDir, "FETCH_HEAD"))
    return { known: true, at: stats.mtime.toISOString() }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { known: false, why: "never (no FETCH_HEAD in the component checkout)" }
    return { known: false, why: `unknown (FETCH_HEAD unreadable: ${code ?? String(error)})` }
  }
}

/** The disclosure every ref-derived refusal carries: where, from what, how old. */
function scopeSentence(scope: PublicationScope): string {
  const fetchClause = scope.fetched.ok
    ? "fetch ok"
    : `fetch FAILED (${scope.fetched.detail}), so this is a possibly-stale read`
  const recency = scope.lastFetchAt.known ? scope.lastFetchAt.at : scope.lastFetchAt.why
  return `Read in '${scope.repo}' from local remote-tracking refs '${scope.refs}'; ${fetchClause}; last fetched ${recency}`
}

function scopeEvidence(scope: PublicationScope): Readonly<{
  readRepo: string
  readRefs: string
  fetchOutcome: "ok" | "failed"
  fetchDetail?: string
  lastFetchAt?: string
}> {
  return {
    readRepo: scope.repo,
    readRefs: scope.refs,
    fetchOutcome: scope.fetched.ok ? "ok" : "failed",
    ...(scope.fetched.ok ? {} : { fetchDetail: scope.fetched.detail }),
    ...(scope.lastFetchAt.known ? { lastFetchAt: scope.lastFetchAt.at } : {}),
  }
}

/**
 * The retry a failed fetch earns.
 *
 * Without it the only remedy offered is "publish the target" — advice that is
 * actively wrong when the target is already published and only the refresh
 * broke.
 */
function retryStep(component: string, target: string | undefined, issue: string): RemedyStepV1 {
  return {
    argv: [
      "yrd",
      "intent",
      "submit",
      "--component",
      component,
      ...(target === undefined ? [] : ["--target", target]),
      "--issue",
      issue,
    ],
    note: "the component fetch failed, so this verdict read possibly-stale refs; retry once the component's origin is reachable",
  }
}

async function readPublication(
  process: Pick<Process, "run">,
  componentRepo: string,
  target: string,
): Promise<PublicationRead> {
  const exists = await tryGit(process, componentRepo, ["cat-file", "-e", `${target}^{commit}`])
  if (exists === undefined) return { published: false, reason: "commit-absent" }
  const refs = await tryGit(process, componentRepo, [
    "for-each-ref",
    "--format=%(refname)",
    `--contains=${target}`,
    "refs/remotes/origin/",
  ])
  if (refs === undefined) return { published: false, reason: "read-failed" }
  return refs.trim() === "" ? { published: false, reason: "no-containing-ref" } : { published: true }
}

async function isAncestor(
  process: Pick<Process, "run">,
  componentRepo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await run(process, componentRepo, ["merge-base", "--is-ancestor", ancestor, descendant])
  if (result.timedOut) throw new Error(`yrd: git merge-base --is-ancestor timed out after ${GIT_TIMEOUT_MS}ms`)
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
  throw new Error(`yrd: git merge-base --is-ancestor failed: ${detail}`)
}

async function run(process: Pick<Process, "run">, cwd: string, args: readonly string[]): Promise<ProcessResult> {
  return process.run({
    argv: ["git", "-C", cwd, ...args],
    cwd,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
}

async function git(process: Pick<Process, "run">, cwd: string, args: readonly string[]): Promise<string> {
  const result = await run(process, cwd, args)
  if (result.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
    throw new Error(`yrd: git ${args.join(" ")} failed: ${detail}`)
  }
  return result.stdout
}

/** Run a probe whose non-zero exit is an ANSWER, not an error. */
async function tryGit(
  process: Pick<Process, "run">,
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  const result = await run(process, cwd, args)
  if (result.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  return result.exitCode === 0 ? result.stdout : undefined
}
