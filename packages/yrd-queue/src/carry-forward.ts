/**
 * Carry-forward: reusing a check verdict across the queue's OWN base motion.
 *
 * When candidate 1 lands, the base moves A -> B and every peer's checked
 * candidate is voided — not because anything it measured changed, but because
 * the coordinate it was measured at moved. Refusing into a recut there re-runs
 * the whole check pipeline for a payload nothing touched, which is what
 * collapses an effective batch depth of 10 to 1.
 *
 * This is CARRY-FORWARD OF A VERDICT, NOT A NEW PROOF. Nothing here re-checks
 * anything. It decides only whether the base motion A..B is narrow enough that
 * the old verdict is still the answer, and it is deliberately conservative:
 * every leg must pass, every refusal names the leg that fired, and anything it
 * cannot prove cheaply (a rename, a missing pin, evidence without an identity)
 * is treated as overlapping and sent down the ordinary recut path.
 *
 * The safety net is not this predicate. It is the shadow recut in
 * {@link shouldShadowRecut}: a sampled fraction of carry-forwards ALSO runs the
 * full check, and a single divergence disables the path until an operator
 * re-enables it.
 */

/** The single git surface this predicate needs. Structural on purpose: the
 * module stays unit-testable against a fake and never owns a process. */
export type CarryForwardGit = Readonly<{
  run: (
    repo: string,
    args: readonly string[],
    allowFailure?: boolean,
  ) => Promise<Readonly<{ code: number; stdout: string }>>
}>

/** Which leg of the predicate refused. Each is a distinct fact about the base
 * motion, never a generic "not eligible". */
export type CarryForwardLeg =
  | "disabled"
  | "kill-switch"
  | "base-ancestry"
  | "tree-disjoint"
  | "build-affecting-motion"
  | "env-fingerprint"
  | "pin-containment"

export type CarryForwardRefusal = Readonly<{ leg: CarryForwardLeg; reason: string }>

export type CarryForwardEvidence = Readonly<{
  configHash?: string
  environmentHash?: string
}>

export type CarryForwardFlowPin = Readonly<{ name: string; rev: string; fingerprint: string }>

export type CarryForwardPin = Readonly<{ path: string; sha: string }>

export type CarryForwardVerdict =
  | Readonly<{
      carried: true
      fromBaseSha: string
      toBaseSha: string
      motionPaths: readonly string[]
      payloadPaths: readonly string[]
    }>
  | Readonly<{ carried: false; refusal: CarryForwardRefusal }>

export type CarryForwardPolicy = Readonly<{
  /** Default ON: the conservative predicate is the safety, not the switch. */
  enabled: boolean
  /** Fraction of carry-forwards that ALSO run the full check as a shadow. */
  shadowSampleRate: number
  /** Set once a shadow recut diverged. Persisted, operator-cleared: a divergence
   * means the predicate was wrong about something, and an in-memory flag would
   * silently re-arm on the next restart. */
  disabledBy?: Readonly<{ reason: string; at: string; run?: string }>
}>

export const DEFAULT_CARRY_FORWARD_POLICY: CarryForwardPolicy = Object.freeze({
  enabled: true,
  shadowSampleRate: 0.1,
})

/**
 * Paths whose motion can change what a check MEASURES, not merely what it
 * measures against — so a verdict minted before the motion says nothing about
 * the tree after it.
 *
 * The lockfile names are exactly the set `@yrd/cli` workspace provisioning
 * knows how to install (`PACKAGE_MANAGERS` in `workspace-provisioning.ts`:
 * bun.lock, bun.lockb, pnpm-lock.yaml, package-lock.json). `package.json` is
 * the manifest every one of those lockfiles is validated against — a frozen
 * install refuses precisely when the two disagree. `yarn.lock` is NOT in the
 * provisioning list; it is here anyway because a lockfile this repo cannot
 * install is a reason to refuse, never a reason to ignore the motion.
 */
const BUILD_AFFECTING_BASENAMES: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "package.json",
  ".yrd.yml",
  ".yrd.yaml",
  ".npmrc",
  ".nvmrc",
  ".tool-versions",
  "vitest.config.ts",
  "vitest.slow.config.ts",
])

/** `tsconfig.json`, `tsconfig.hh.json`, and any sibling variant. */
const BUILD_AFFECTING_PATTERNS: readonly RegExp[] = [/^tsconfig(\..+)?\.json$/u]

/** Directory prefixes whose entire subtree is build- or CI-affecting. */
const BUILD_AFFECTING_PREFIXES: readonly string[] = [".github/", ".yrd/", "scripts/"]

function basename(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? path : path.slice(index + 1)
}

/** True when a path is one the check's own outcome depends on. */
export function isBuildAffectingPath(path: string): boolean {
  const name = basename(path)
  if (BUILD_AFFECTING_BASENAMES.has(name)) return true
  if (BUILD_AFFECTING_PATTERNS.some((pattern) => pattern.test(name))) return true
  return BUILD_AFFECTING_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/** True when either path is the other, or lies inside the other as a
 * directory. Plain set intersection misses `src/` moving under a candidate
 * that edits `src/a.ts`. */
function pathsTouch(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

type NameStatus = Readonly<{ paths: readonly string[]; renamed: readonly string[] }>

/** Parse `git diff --name-status -M` into its paths, keeping rename/copy rows
 * separate so the caller can refuse rather than reason about them. */
export function parseNameStatus(stdout: string): NameStatus {
  const paths: string[] = []
  const renamed: string[] = []
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue
    const fields = line.split("\t")
    const status = fields[0] ?? ""
    const rest = fields.slice(1).filter((field) => field !== "")
    if (rest.length === 0) continue
    if (status.startsWith("R") || status.startsWith("C")) renamed.push(...rest)
    paths.push(...rest)
  }
  return { paths: [...new Set(paths)].toSorted(), renamed: [...new Set(renamed)].toSorted() }
}

async function nameStatus(git: CarryForwardGit, repo: string, from: string, to: string): Promise<NameStatus> {
  const diff = await git.run(repo, [
    "diff",
    "--name-status",
    "-M",
    "--no-ext-diff",
    "--ignore-submodules=none",
    from,
    to,
  ])
  return parseNameStatus(diff.stdout)
}

function refuse(leg: CarryForwardLeg, reason: string): CarryForwardVerdict {
  return { carried: false, refusal: { leg, reason } }
}

export type CarryForwardRequest = Readonly<{
  repo: string
  /** The base the existing verdict was minted at. */
  fromBaseSha: string
  /** The base the queue is at now. */
  toBaseSha: string
  /** The candidate the verdict was minted for. */
  candidateSha: string
  evidence: CarryForwardEvidence
  /** Flow pins of every member of the run. */
  flows: readonly (CarryForwardFlowPin | undefined)[]
  /** Submodule pins the original check proved. */
  pins: readonly CarryForwardPin[]
  policy: CarryForwardPolicy
  /** Reads the gitlink a commit records for a submodule path, or undefined
   * when the path is not a gitlink there. */
  readGitlink: (repo: string, commit: string, path: string) => Promise<string | undefined>
}>

/**
 * Decide whether the verdict minted at `fromBaseSha` still answers for
 * `toBaseSha`. Every leg must pass; the first failure names itself.
 */
export async function carryForwardVerdict(
  git: CarryForwardGit,
  request: CarryForwardRequest,
): Promise<CarryForwardVerdict> {
  const { repo, fromBaseSha, toBaseSha, candidateSha, policy } = request
  if (policy.disabledBy !== undefined) {
    return refuse(
      "kill-switch",
      `carry-forward is disabled since ${policy.disabledBy.at} after ${policy.disabledBy.reason}; ` +
        `re-enable it explicitly once the divergence is understood`,
    )
  }
  if (!policy.enabled) return refuse("disabled", "carry-forward is disabled by configuration")

  // Leg 0 — the motion must BE a forward motion of the same base. A rewritten
  // or rolled-back base is not "the queue landed something"; nothing below
  // would be measuring what it claims to.
  if (fromBaseSha === toBaseSha) {
    return refuse("base-ancestry", `checked base '${fromBaseSha}' did not move; carry-forward has nothing to carry`)
  }
  const forward = await git.run(repo, ["merge-base", "--is-ancestor", fromBaseSha, toBaseSha], true)
  if (forward.code !== 0) {
    return refuse(
      "base-ancestry",
      `checked base '${fromBaseSha}' is not an ancestor of current base '${toBaseSha}'; ` +
        `the base was rewritten, not advanced`,
    )
  }

  // Leg 1 — the payload and the motion must touch disjoint trees.
  const motion = await nameStatus(git, repo, fromBaseSha, toBaseSha)
  if (motion.renamed.length > 0) {
    return refuse(
      "tree-disjoint",
      `base motion ${fromBaseSha}..${toBaseSha} renames or copies [${motion.renamed.join(", ")}]; ` +
        `disjointness cannot be proven cheaply across a rename`,
    )
  }
  const payload = await nameStatus(git, repo, fromBaseSha, candidateSha)
  if (payload.renamed.length > 0) {
    return refuse(
      "tree-disjoint",
      `candidate payload renames or copies [${payload.renamed.join(", ")}]; ` +
        `disjointness cannot be proven cheaply across a rename`,
    )
  }
  const overlapping = payload.paths.filter((path) => motion.paths.some((moved) => pathsTouch(path, moved)))
  if (overlapping.length > 0) {
    return refuse(
      "tree-disjoint",
      `candidate payload and base motion ${fromBaseSha}..${toBaseSha} both touch [${overlapping.join(", ")}]`,
    )
  }

  // Leg 2 — the motion must not change what the check measures.
  const buildAffecting = motion.paths.filter((path) => isBuildAffectingPath(path))
  if (buildAffecting.length > 0) {
    return refuse(
      "build-affecting-motion",
      `base motion ${fromBaseSha}..${toBaseSha} touches build-affecting [${buildAffecting.join(", ")}]`,
    )
  }

  // Leg 3 — the check's own identity must be recorded and one flow must own
  // every member. Evidence without an identity is legacy evidence: it cannot
  // be compared against a shadow recut, so it is never carried.
  if (request.evidence.configHash === undefined) {
    return refuse("env-fingerprint", "checked evidence records no configHash; its check identity cannot be compared")
  }
  const pins = request.flows.map((flow) => (flow === undefined ? "" : `${flow.name}\0${flow.rev}\0${flow.fingerprint}`))
  const distinct = [...new Set(pins)]
  if (distinct.length > 1) {
    return refuse(
      "env-fingerprint",
      `run members declare ${distinct.length} different flow pins; one config must own every member`,
    )
  }

  // Leg 4 — every pin the check proved must still hold at the new base. If the
  // base advanced a submodule PAST the pin the candidate carries, landing the
  // candidate would move that submodule backwards and the old verdict never
  // measured that tree.
  for (const pin of request.pins) {
    const atBase = await request.readGitlink(repo, toBaseSha, pin.path)
    if (atBase === undefined) {
      return refuse(
        "pin-containment",
        `checked candidate pins submodule '${pin.path}' but base '${toBaseSha}' records no gitlink there`,
      )
    }
    if (atBase === pin.sha) continue
    const contained = await git.run(repo, ["merge-base", "--is-ancestor", atBase, pin.sha], true)
    if (contained.code !== 0) {
      return refuse(
        "pin-containment",
        `base '${toBaseSha}' pins submodule '${pin.path}' at '${atBase}', which the checked pin '${pin.sha}' ` +
          `does not contain; landing the carried candidate would move it backwards`,
      )
    }
  }

  return {
    carried: true,
    fromBaseSha,
    toBaseSha,
    motionPaths: motion.paths,
    payloadPaths: payload.paths,
  }
}

/**
 * Whether THIS carry-forward also runs the full check as a shadow.
 *
 * `random` is injected so the sampling is testable and so a host can make it
 * deterministic; the default caller passes `Math.random`.
 */
export function shouldShadowRecut(policy: CarryForwardPolicy, random: () => number): boolean {
  if (policy.shadowSampleRate <= 0) return false
  if (policy.shadowSampleRate >= 1) return true
  return random() < policy.shadowSampleRate
}

export type ShadowDivergence = Readonly<{ carried: "passed" | "failed"; fresh: "passed" | "failed"; detail: string }>

/**
 * Compare a carried verdict against the shadow recut that re-ran underneath
 * it. A divergence is the one fact that retires this whole path, so it names
 * BOTH verdicts rather than reporting a bare mismatch.
 */
export function shadowDivergence(
  carried: "passed" | "failed",
  fresh: "passed" | "failed",
  context: Readonly<{ fromBaseSha: string; toBaseSha: string; candidateSha: string }>,
): ShadowDivergence | undefined {
  if (carried === fresh) return undefined
  return {
    carried,
    fresh,
    detail:
      `carried verdict '${carried}' from base '${context.fromBaseSha}' disagrees with a fresh check '${fresh}' ` +
      `at base '${context.toBaseSha}' for candidate '${context.candidateSha}'`,
  }
}
