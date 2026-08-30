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
  return quotedValue(message, /\('([^']+)'\)/u) ?? quotedValue(message, /\bfrom '([^']+)'/iu) ?? "<advance worktree>"
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

/** `yrd pr runs <change>` as evidence, exactly when the message actually
 * names a change — never with the `refusedChange` placeholder, which would
 * print a literal `<change>` a reader cannot run. Composition-time refusals
 * (candidate build, before a merge) commonly name the change this way; the
 * ones that don't are repo-wide or submodule-scoped, not this change's alone. */
function changeRunsEvidence(message: string): readonly string[] {
  return quotedValue(message, /change '([^']+)'/iu) === undefined ? [] : [`yrd pr runs ${refusedChange(message)}`]
}

/**
 * Shared by `candidate-change-id-missing` and `recut-change-id-missing`: a
 * pre-identity record gets a stable Change-Id only by taking the mint path —
 * a fresh branch — never by "migrating" the existing one, which no verb
 * implements. Re-pushing the SAME branch resolves to the same change
 * (identity is branch-keyed) and refuses again identically. See command.ts's
 * `NO_CHANGE_ID_MIGRATION_REMEDY`, the message-side half of the same fix
 * (`candidate-change-id-missing`'s producer said "migrate it before
 * rebuilding" until that fix — a verb that does not exist).
 */
function noChangeIdCure(message: string): RefusalCureText {
  return {
    blocked:
      "There is no migration verb — identity is never invented for an existing record, and re-pushing this " +
      "same branch resolves to the same change and refuses again (identity is branch-keyed). Delivering the " +
      "payload under a NEW branch name takes the mint path and gets a stable Change-Id (see cause).",
    evidence: changeRunsEvidence(message),
    resolution: [],
  }
}

/**
 * Shared by the five codes where composing this candidate needed to read
 * `subject` across a git commit range and could not (a `git diff`/`merge-base`
 * that exited non-zero) — a fact about the branch's own git history, never
 * about the queue. Restoring readable history (an unshallow fetch, or
 * whatever git could not read, per the cause above) is the fix; resubmitting
 * the unchanged branch reads the identical range and refuses the same way.
 */
function unreadableRangeCure(subject: string): CureEntry {
  return (message) => ({
    blocked:
      `Composing this candidate needs to read ${subject} across a git commit range, and the compose step ` +
      `could not (see cause) — a fact about the branch's own git history, not about the queue. Restoring ` +
      `readable history is the fix; resubmitting the unchanged branch reads the identical range and refuses ` +
      `the same way.`,
    evidence: changeRunsEvidence(message),
    resolution: [],
  })
}

/**
 * Shared by the two codes where a merge produced a result that drops content
 * neither parent's branch authored removing — `subject` names what. The fix
 * is the author's own merge of the current base, which turns the drop into a
 * reviewable diff; resubmitting the unchanged branch reproduces the
 * identical drop.
 */
function droppedContentCure(subject: string): CureEntry {
  return (message) => ({
    blocked:
      `The merge dropped ${subject} (see cause for what, and against what). Merging the current base into the ` +
      `branch and restoring that content is the fix; resubmitting the unchanged branch reproduces the identical ` +
      `drop.`,
    evidence: changeRunsEvidence(message),
    resolution: [],
  })
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
  // THE NEEDS-AUTHOR BATCH: every code COMPOSITION_FAILURE_BUCKETS (queue.ts)
  // buckets `needs-author` that is not already censused elsewhere. Two of the
  // sixteen are deliberately ABSENT from this table: `authored-gitlink` and
  // `component-model-authorization-refused` need @cto's authority, not a
  // self-serve step, and are censused in ESCALATION_CENSUS
  // (actionable-error.ts) instead — the two tables stay disjoint by design
  // (refusal-cure-census.test.ts's needs-author sweep excludes the first by
  // name and finds the second escalated).
  //
  // Before this batch, 0 of the sixteen had a registered cure here: the
  // remedy each producer already prints lived only as message prose,
  // invisible to `--json` and to a reader asking the registry "what is the
  // cure for code X" — and one of them (`candidate-change-id-missing`) had
  // gone STALE: its "migrate it before rebuilding" line named a verb that
  // does not exist, fixed alongside this batch in command.ts (one shared
  // constant with `recut-change-id-missing`'s already-corrected wording).
  //
  // None of these fourteen prints a MECHANICAL resolution: every one needs an
  // author action no Yrd verb performs (restore readable history, land a
  // commit on a submodule's own main, merge the current base, drop a path,
  // deliver under a new branch). `resolution` therefore stays EMPTY across
  // this whole batch — never a bare `yrd pr submit <branch>` alone, which
  // `classifyRefusalRemedy` (refusal-remedy.ts) would read as a complete,
  // self-applicable redelivery drill and let the runner loop resubmitting an
  // unchanged branch against a refusal that fails it identically every time.
  "candidate-change-id-missing": noChangeIdCure,
  "recut-change-id-missing": noChangeIdCure,
  "contribution-inspection": unreadableRangeCure("the lines each parent's branch kept"),
  "deletion-inspection": unreadableRangeCure("the deletions this change authors"),
  "gitlink-inspection": unreadableRangeCure("the gitlinks this change authors"),
  "refused-path-inspection": unreadableRangeCure("the payload paths this change touches"),
  "payload-certificate": unreadableRangeCure("a stable identity for this change's diff"),
  "dropped-parent-contribution": droppedContentCure("content neither parent authored removing"),
  "unauthored-path-deletion": droppedContentCure("paths this change's own authored diff never deletes"),
  // The author's gitlink is a min commit, never a value — it needs the same
  // fast-forward-first framing `authoredGitlinkFailure`'s ordinary arm
  // (actionable-error.ts) already uses for the sibling `authored-gitlink`
  // code, not a copy of the generic tail this used to fall through to.
  "min-commit-unpublished": (message) => ({
    blocked:
      "Get the named commit onto the submodule's own main first (see cause) — the queue cannot promote a min " +
      "commit it cannot reach there, and no retry of this command changes that.",
    evidence: changeRunsEvidence(message),
    resolution: [],
  }),
  "carrier-drops-landed": (message) => ({
    blocked:
      "The submodule side of this change would drop commits already landed on the submodule's target (see " +
      "cause) — merging that target into the submodule work and pushing it is the fix; resubmitting the " +
      "unchanged branch reproduces the identical drop.",
    evidence: changeRunsEvidence(message),
    resolution: [],
  }),
  "composition-retired": (message) => ({
    blocked:
      "Composed revisions are retired — nothing rebuilds a composition record. Submit the root change with " +
      "its authored gitlink bumps instead; the queue fills the shaset from each submodule's main itself.",
    evidence: changeRunsEvidence(message),
    resolution: [],
  }),
  "refused-path": (message) => ({
    blocked:
      "These paths sit outside what this branch may carry (see cause) — moving them to where they belong is " +
      "the author's own edit; no Yrd verb performs it, and resubmitting the unchanged branch touches the same " +
      "paths and refuses again.",
    evidence: changeRunsEvidence(message),
    resolution: [],
  }),
  "wrapper-mismatch": (message) => ({
    blocked:
      "The queue's own generated gitlink-wrapper commit did not come out matching what this composition " +
      "expected (see cause) — whatever the detail above names as unexpected is the author's to fix first; a " +
      "fresh composition then rebuilds the wrapper from the current base and each submodule's main.",
    evidence: changeRunsEvidence(message),
    resolution: [],
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
