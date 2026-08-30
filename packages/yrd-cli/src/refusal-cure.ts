import { canonicalRefusalCode, type CanonicalRefusalCodeOptions, type RefusalCode } from "@yrd/queue"

/**
 * Where a reader SEES a failure for themselves — an exact artifact path, or a
 * `yrd …` command that prints the record. Never a description of where to
 * look; the whole defect this closes is a refusal that summarizes evidence it
 * does not name.
 */
export type FailureEvidence = Readonly<{ text: string; href?: string }>

/** The cure a registered refusal carries, in the three parts a stopped reader
 * needs and in the order they need them. */
export type RefusalCureText = Readonly<{
  /**
   * Why the obvious move — retry, re-push, resubmit — does not clear this.
   *
   * Load-bearing, not commentary: for a code the QUEUE recovers automatically,
   * the correct action is none, and a remedy list is the wrong shape for that
   * answer. `resolution` may be empty exactly when this is present, and the
   * census asserts that pairing, so "no step" can never read as "nobody wrote
   * one".
   */
  blocked?: string
  evidence: readonly string[]
  /**
   * What the reader DOES. Every line is an executable `yrd …` command — the
   * 2026-08-27 ADR amendment's rule, promoted from advice to a shape the
   * census enforces: prose here does not survive `oneLineCause` /
   * `embeddedYrdCommands`, so prose here is text nobody reads.
   */
  resolution: readonly string[]
}>

type CureEntry = (message: string) => RefusalCureText

export function quotedValue(message: string, pattern: RegExp): string | undefined {
  return pattern.exec(message)?.[1]
}

/** The change a refusal is about, spelled the way every producer spells it
 * (`change 'PR7'`), so a printed step names the exact selector a human would
 * type instead of a placeholder they have to resolve first. */
export function refusedChange(message: string): string {
  return quotedValue(message, /change '([^']+)'/iu) ?? "<change>"
}

/** The queue base a hold was declared against (`queue 'main' is paused: …`). */
export function heldQueueBase(message: string): string {
  return quotedValue(message, /queue '([^']+)'/iu) ?? "<base>"
}

/** The submodule a submodule-main refusal is about. Every producer of that
 * family spells it `submodule '<path>'`, so the printed cure can name the path
 * the reader must act on rather than `<submodule>`. */
function refusedSubmodule(message: string): string {
  return quotedValue(message, /submodule '([^']+)'/iu) ?? "<submodule>"
}

/** The worktree a gitlink-advance refusal names — as `('<path>')` after the
 * bay it belongs to, or as `from '<path>'`. Where the reader looks, so the
 * evidence is a place and not a description of one. */
function advanceWorktree(message: string): string {
  return (
    quotedValue(message, /\('([^']+)'\)/u) ?? quotedValue(message, /\bfrom '([^']+)'/iu) ?? "<advance worktree>"
  )
}

/** The bay a gitlink-advance refusal left standing (`in bay '<name>'`). The
 * bay is the whole point of the cure: the work is not lost, and a reader who
 * is not told its name opens a second one. */
function refusedBay(message: string): string {
  return quotedValue(message, /\bbay '([^']+)'/iu) ?? "<bay>"
}

/**
 * The artifact a step failure already named. `configuredCommand` writes
 * `; full output: <path>` into every non-zero-exit refusal, so this is a
 * READ of a fact the message carries, never a path this module invents — an
 * invented path is the same defect as an invented verb.
 */
function namedOutputLog(message: string): readonly string[] {
  const path = quotedValue(message, /full output:\s*(\S+)/iu)
  return path === undefined ? [] : [path]
}

/** The check whose command exited non-zero, from the same producer's headline
 * (`affected-tests command exited 1: …`). */
function refusedCheck(message: string): string | undefined {
  return quotedValue(message, /^(?:yrd:\s*)?([a-z][a-z0-9-]*)\s+(?:command|launcher)\s+exited\b/iu)
}

/**
 * THE CURE CENSUS — for a refusal that STOPPED someone, what they read and
 * what they run.
 *
 * Distinct from `ESCALATION_CENSUS` (actionable-error.ts) and deliberately
 * disjoint from it: that table is for refusals whose cure needs an authority
 * the reader does not hold, and its contract is that the resolution IS the
 * escalation. This one is for refusals the reader CAN act on, or that the
 * queue clears itself — where the failure was never "who decides" but "the
 * text told me nothing".
 *
 * MEMBERSHIP RULE: the refusal's own message does not already carry an
 * executable cure. A producer that prints `run 'yrd …'` needs no entry —
 * `embeddedYrdCommands` already lifts it onto a `resolve:` line — and a second
 * copy here is precisely the failure `fc6bd709` recorded: the same wrong cure
 * written twice, neither validated, one of them outliving the fix to the
 * other. Entries are keyed by {@link RefusalCode} so a code the queue does not
 * register cannot compile, and `refusal-cure-census.test.ts` proves every verb
 * a cure prints is one the real CLI registers.
 */
const CURE_CENSUS: Readonly<Partial<Record<RefusalCode, CureEntry>>> = {
  // Bucketed `{ stale, auto-requeue, queue }`: the queue re-runs checks for
  // this change on its own next pass. So the honest remedy list is EMPTY, and
  // the old rendered next-action — "refresh the current PR revision against
  // queue authority, then rerun it" — named an operation no verb performs and
  // work nobody needed to do.
  "stale-check": (message) => ({
    blocked:
      `The checked candidate moved, so its checks no longer describe it. The queue requeues change ` +
      `'${refusedChange(message)}' for fresh checks on its next pass — re-pushing the same branch does not make that ` +
      `happen sooner, and mints a revision nobody needed.`,
    evidence: [`yrd pr checks ${refusedChange(message)}`],
    resolution: [],
  }),
  // The failing push is the QUEUE's own push of the merged result to the base.
  // Presenting it to the author as "correct the cause, then retry the same Yrd
  // command" bills them for a fault their branch has no part in.
  "merge-push-failed": (message) => ({
    blocked:
      `This is the queue's own push of the merged result to the base, not a push of change ` +
      `'${refusedChange(message)}' — nothing about the branch is wrong and re-submitting it changes nothing. If the ` +
      `base simply moved, the next pass re-merges; if the remote refused the update itself, the base ref's ` +
      `protection or this host's push credential is what changed, and no Yrd verb reaches either.`,
    evidence: [`yrd pr runs ${refusedChange(message)}`],
    resolution: [],
  }),
  // The queue's own admission text USED to offer "or request fresh checks",
  // and no verb requests checks — the exact class this bead exists for. That
  // producer now names new content instead (queue.ts, required-check-failed);
  // this entry answers the same lie on the merge path, where it was never a
  // producer's to fix. A certificate is minted BY a check run, so the cure is
  // a check run, and a check run comes from a revision.
  "checkpoint-migration-certificate-missing": (message) => ({
    blocked:
      `A checkpoint-migration certificate is minted by a CHECK run and never by a merge, so nothing on the merge ` +
      `path can produce one and retrying the merge refuses identically. There is no verb that "requests fresh ` +
      `checks": a fresh check run comes from a fresh revision.`,
    evidence: [`yrd pr runs ${refusedChange(message)}`],
    resolution: [`yrd pr checks ${refusedChange(message)}`, "yrd pr submit <branch>"],
  }),
  "checkpoint-migration-certificate-stale": (message) => ({
    blocked:
      `The certificate describes the commit pair it was checked against, and this change has moved since. A ` +
      `certificate cannot be re-bound; only a fresh check run against the current base mints one that matches.`,
    evidence: [`yrd pr runs ${refusedChange(message)}`],
    resolution: [`yrd pr checks ${refusedChange(message)}`, "yrd pr submit <branch>"],
  }),
  // The generic required-check bucket: every `<purpose>-failed` code
  // canonicalizes here, so this one entry serves affected-tests, the
  // pre-submit guards, and every configured check.
  "check-failed": (message) => {
    const check = refusedCheck(message)
    return {
      blocked:
        `The check judged the WORK, not the queue: the same revision fails the same way on every retry, and the ` +
        `queue will not admit it until the branch changes.`,
      evidence: namedOutputLog(message),
      resolution: [
        ...(check === undefined ? [] : [`yrd check ${check}`]),
        `yrd pr runs ${refusedChange(message)}`,
        "yrd pr submit <branch>",
      ],
    }
  },
  // THE GITLINK ADVANCE'S OWN REFUSALS. Each ends in `-failed`, so each used
  // to render the `check-failed` cure — "The check judged the WORK, not the
  // queue", `yrd pr runs <change>`, `yrd pr submit <branch>` — in the human
  // text and in the `--json` failure document alike, for a git push that no
  // check ever judged. `gitlink-commit-failed` is deliberately ABSENT: its
  // producer already prints a quoted `'yrd in <bay>'`, which
  // `embeddedYrdCommands` lifts, and the census's membership rule is that a
  // second copy of a cure is how the wrong one outlives the fix to the first.
  //
  // The push of the ADVANCE branch to the superproject's origin, after the
  // gitlink commit was already made.
  "advance-branch-push-failed": (message) => ({
    blocked:
      `The gitlink commit was already made and the bay still holds it, so nothing about the advance needs redoing ` +
      `— this is the push of its branch to the superproject's origin. A refused remote is not a fact about the ` +
      `commit: the base ref's protection or this host's push credential is what changed, and no Yrd verb reaches ` +
      `either.`,
    evidence: [advanceWorktree(message)],
    resolution: [],
  }),
  // The publish of the target onto the SUBMODULE's own main — a different
  // remote from the one every other step of the advance touches.
  "min-commit-publish-failed": (message) => ({
    blocked:
      `This is a push to the OWN origin of submodule '${refusedSubmodule(message)}', not the superproject's: a ` +
      `gitlink ` +
      `may only record a commit that is already on the component's main, and that publish is what was refused. ` +
      `Re-running the advance repeats the same push and the same refusal until that main accepts the commit.`,
    evidence: [`git -C ${refusedSubmodule(message)} log --oneline origin/main..HEAD`],
    resolution: [`yrd gitlink advance ${refusedSubmodule(message)}`],
  }),
  // The index write inside the advance's own bay.
  "gitlink-stage-failed": (message) => ({
    blocked:
      `The bay is open with the submodule already checked out at the target; only the index write failed, so the ` +
      `work is not lost. Re-running the advance opens a SECOND bay rather than reusing this one, which is why the ` +
      `step below joins the existing one.`,
    evidence: [advanceWorktree(message)],
    resolution: [`yrd in ${refusedBay(message)}`],
  }),
  // Bucketed infra-retry, so a transport blip clears itself — but the SAME
  // code is raised for a submodule main this host genuinely cannot read, which
  // no retry clears. Naming both, and which is which, is the cure: "could not
  // tell" and "not published" have opposite remedies, and the queue refuses
  // rather than guess between them.
  "component-main-inspection-failed": (message) => ({
    blocked:
      `The submodule's own main could not be READ, so the queue cannot tell a published pin from an unpublished ` +
      `one — opposite cures — and refuses rather than guess. This is requeued automatically, so a fetch blip ` +
      `clears itself; one that repeats means this host cannot reach the origin of '${refusedSubmodule(message)}', ` +
      `and restoring that access is the cure no Yrd verb performs.`,
    evidence: [`yrd pr runs ${refusedChange(message)}`],
    resolution: [`yrd gitlink advance ${refusedSubmodule(message)}`],
  }),
}

export const REFUSAL_CURES: Readonly<Partial<Record<RefusalCode, CureEntry>>> = CURE_CENSUS

/**
 * The cure registered for a raw failure code, resolved through the queue's own
 * alias table first so an older spelling of a registered code — and every
 * dynamic `<purpose>-failed` step code, which canonicalizes to `check-failed`
 * — reaches the same entry.
 *
 * Pass `dynamicStepFamily: false` when the code did NOT come from a durable
 * step result. A CLI verb's own `-failed` code is not a step name, and the
 * suffix family cannot tell the difference: see
 * {@link CanonicalRefusalCodeOptions}.
 */
export function refusalCure(
  code: string,
  message: string,
  options: CanonicalRefusalCodeOptions = {},
): RefusalCureText | undefined {
  const canonical = canonicalRefusalCode(code, options)
  if (canonical === undefined) return undefined
  const entry = CURE_CENSUS[canonical]
  return entry === undefined ? undefined : Object.freeze(entry(message))
}
