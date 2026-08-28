import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { systemClock } from "@yrd/core"
import { createExclusive } from "@yrd/persistence"
import type { Process } from "@yrd/process"
import * as z from "zod"
import { CHANGE_ID_TRAILER_KEY, changeIdTrailerCandidates, findChangeId } from "./change-identity.ts"
import { GitRefSchema, GitShaSchema } from "./model.ts"

const RECEIVER_VERSION = 1 as const
const RESULT_VERSION = 1 as const
const MANAGED_HOOK_MARKER = "// yrd-managed-receiver-hook:1"
const MANAGED_HOOK_PREFIX = "#!/usr/bin/env bun\n// yrd-managed-receiver-hook:"
const BRANCH_PREFIX = "refs/heads/"
/**
 * Gerrit's submit namespace, adopted verbatim per the git-layer compatibility
 * ruling: a push to `refs/for/<base>/<change>` IS the submission, so a change
 * that is pushed but unsubmitted has no representation at all.
 */
const SUBMIT_PREFIX = "refs/for/"
/**
 * The branch-is-change model's approval fact (bead-branch-is-change, phase 1).
 * `refs/yrd/submit/<branch>` names the exact commit its author approves to
 * merge — pushing it IS the API, exactly like `refs/for/` is for Gerrit-shaped
 * submission. Distinct from `SUBMIT_PREFIX` above: that namespace names a
 * CHANGE that predates its branch; this one approves a commit on a branch
 * that already exists.
 */
const SUBMIT_REF_PREFIX = "refs/yrd/submit/"
/**
 * The branch-is-change model's shelf: a deleted branch is never gone, it is
 * moved here (`<branch>-<old-tip-shortsha>`). Permanent — the receiver
 * refuses every direct write, create or delete; the only way onto or off of
 * this namespace is `authorize()` translating a `refs/heads/` deletion.
 */
const ARCHIVE_REF_PREFIX = "refs/yrd/archive/"
/**
 * Phase 1b's two instance-override (scope) namespaces (bead-branch-is-change,
 * "Scope — auto-draft by pattern, explicit draft by act"). Existence is the
 * fact — the value is largely irrelevant, always the branch's own tip at
 * write time. Mutually exclusive per branch: accepting one sweeps the other
 * for the SAME branch in the same transaction (`sweepOppositeScopeRef`).
 */
const DRAFT_REF_PREFIX = "refs/yrd/draft/"
/** @see DRAFT_REF_PREFIX */
const IGNORE_REF_PREFIX = "refs/yrd/ignore/"
const ZERO_SHA = /^0+$/u
const HEX_SHA = /^[0-9a-f]+$/u
const REPOSITORY_ENV =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|COMMON_DIR|NAMESPACE|PREFIX|IMPLICIT_WORK_TREE)$/u

type Environment = Record<string, string | undefined>
type HookMode = "pre-receive" | "post-receive"
type ResultState = "prepared" | "pending"

const TextSchema = z.string().trim().min(1)
const ReceiverRefUpdateSchema = z
  .object({ oldSha: z.string().regex(HEX_SHA), newSha: z.string().regex(HEX_SHA), ref: TextSchema })
  .strict()
const ReceiverTargetSchema = z
  .object({
    bay: TextSchema.optional(),
    name: TextSchema.optional(),
    /**
     * The issue this change belongs to. A `refs/for/<base>/<change>` push names
     * one in the ref itself, and dropping it here would mean yrd forgot the
     * only thing the push carried beyond its commits.
     */
    issue: TextSchema.optional(),
    base: GitRefSchema,
    baseSha: GitShaSchema,
    /**
     * The carrier branch this change merges on. A `refs/heads/` push already
     * names its branch in the ref, so this stays absent there. A `refs/for/`
     * push does NOT — the ref names the change — so the resolver, which is
     * what opens the bay, is the only party that knows it.
     */
    branch: GitRefSchema.optional(),
  })
  .strict()
const ReceiverResultSchema = z
  .object({
    version: z.literal(RESULT_VERSION),
    id: z.string().regex(/^[0-9a-f]{64}$/u),
    receivedAt: z.iso.datetime({ offset: true }),
    ref: TextSchema,
    branch: GitRefSchema,
    /**
     * The change name parsed out of a `refs/for/<base>/<change>` push. Stored
     * so the result's identity check stays a pure function of the result:
     * without it, a submit result could only be checked against its base, and
     * a result that cannot fully check its own ref is a result that can lie.
     */
    change: TextSchema.optional(),
    oldSha: GitShaSchema,
    headSha: GitShaSchema,
    intake: ReceiverTargetSchema.extend({
      branch: GitRefSchema,
      headSha: GitShaSchema,
      /** Present only when the accepted ref itself was the submission act. */
      submit: z.literal(true).optional(),
    }).strict(),
  })
  .strict()

export type ReceiverRefUpdate = z.infer<typeof ReceiverRefUpdateSchema>
export type ReceiverTarget = z.infer<typeof ReceiverTargetSchema>
export type ReceiverResult = z.infer<typeof ReceiverResultSchema>
export type GitPushReceiver = Readonly<{
  version: typeof RECEIVER_VERSION
  receiverPath: string
  mainRepo: string
  stateDir: string
  inboxDir: string
  objectFormat: "sha1" | "sha256"
  shaLength: 40 | 64
  process: Pick<Process, "run">
  prepare(input: string | readonly ReceiverRefUpdate[], options: ReceiverHookOptions): Promise<ReceiverResult[]>
  finalize(input: string | readonly ReceiverRefUpdate[], options: ReceiverHookOptions): Promise<ReceiverResult[]>
  drain(
    options: ReceiverHookOptions & { intake: DurableReceiverIntake; lockTimeoutMs?: number },
  ): Promise<ReceiverDrainResult>
}>
/**
 * What a `refs/for/<base>/<change>` push asks for, parsed out of the ref.
 *
 * Present only for submit pushes. Its absence is the signal that the resolver
 * is being asked the OLD question — "does an active bay track this branch?" —
 * and its presence is the signal that no bay exists yet and admission is what
 * creates one.
 */
export type ReceiverSubmitIntent = Readonly<{ base: string; name: string }>
export type ResolveReceiverTarget = (
  branch: string,
  update: Readonly<ReceiverRefUpdate>,
  intent?: ReceiverSubmitIntent,
) => ReceiverTarget | null | undefined | Promise<ReceiverTarget | null | undefined>

/**
 * Judge the pushed head's own `.yrd.yml` — its raw text, or undefined when the
 * pushed tree has none (a real, valid answer: no file means the built-in
 * defaults, the same as `loadYrdConfig` reading a base with no config). Throw
 * to refuse the push; the receiver never parses config itself (`@yrd/bay`
 * cannot depend on `@yrd/cli`'s schema without a cycle), only reads the blob
 * and hands it to whichever schema the caller owns.
 */
export type ReceiverConfigValidator = (yaml: string | undefined) => void | Promise<void>

/**
 * The winning `auto:` classification for one branch, or undefined when
 * nothing matches (untracked). "draft" writes no ref (draft is the default —
 * tracked, no decision recorded); "ignore" and "submit" each materialize
 * their own instance ref.
 */
export type ReceiverAutoClassification = "draft" | "submit" | "ignore"

/**
 * Classify one branch against the BASE branch's own `.yrd.yml` `auto:` block
 * — draft/ignore/submit glob lists, precedence ignore > submit > draft —
 * given the base's raw config text (never the pushed branch's own; scope
 * authority lives with the trusted, already-landed config, mirroring
 * `readConfigFromBase` in `@yrd/cli/host.ts`) and the branch name. `undefined`
 * yaml means the base has no config at all — the same "no file means the
 * built-in defaults" reading `ReceiverConfigValidator` already uses, never a
 * skip. The receiver never parses `.yrd.yml` or evaluates glob patterns
 * itself (`@yrd/bay` cannot depend on `@yrd/cli`'s schema, or take on a glob
 * dependency of its own, without a cycle/scope creep) — it only reads the
 * base's blob and hands it, with the branch name, to whichever classifier the
 * caller owns. Called twice per branch, for two different questions: once at
 * creation (which ref, if any, gets materialized) and, for branches whose
 * name currently classifies as "submit", again on every later plain push
 * (does this push re-submit) — re-evaluated fresh each time against the
 * CURRENT config, never inferred from whether a submit ref already exists (a
 * manual submit must not turn a branch into a standing lane).
 */
export type ReceiverAutoClassifier = (
  yaml: string | undefined,
  branch: string,
) => ReceiverAutoClassification | undefined | Promise<ReceiverAutoClassification | undefined>

/** Intake must atomically deduplicate result.id with its own durable event. */
export type DurableReceiverIntake = (result: Readonly<ReceiverResult>) => void | Promise<void>
export type ReceiverHookOptions = {
  resolveTarget: ResolveReceiverTarget
  intake?: DurableReceiverIntake
  clock?: () => string
  env?: Environment
  /**
   * One sentence naming what intake requires, rendered into the refusal when
   * `resolveTarget` declines a branch. The receiver cannot know the reason —
   * authorization is the resolver's to define — so the policy travels from
   * whoever owns it. Omit and the refusal is unchanged.
   */
  intakePolicy?: string
  /**
   * Judge the pushed head's `.yrd.yml` before the push is accepted. Omit and
   * the receiver reads and stores the push unjudged, exactly as it always
   * has — this gate is additive, never a default behavior change for a caller
   * that has not wired a schema in yet.
   */
  validateConfig?: ReceiverConfigValidator
  /**
   * Classify a branch against its base's `auto:` block. Omit and no branch is
   * ever auto-classified — additive, like `validateConfig`: a caller that has
   * not wired a classifier in yet keeps today's behavior (draft/ignore/submit
   * refs remain purely instance decisions, never auto-materialized).
   */
  classifyBranch?: ReceiverAutoClassifier
  /**
   * Whether a LIVE change record already owns this carrier branch — the S6
   * record lane (the production predicate is `recordLaneOwnsBranch` over the
   * bays state, which this receiver cannot read itself). Consulted only by
   * the push-time Change-Id gate on a `refs/for/` push: a record-owned
   * branch derives its identity from the record internally, so its
   * grandfathered re-pushes stay exempt from the tip-trailer requirement.
   * Omit and NO branch is exempt — post-S6 a recordless refs/for push IS the
   * whole submission, so strict is the only safe default for a caller that
   * wired no record state in.
   */
  recordOwnsBranch?: (branch: string) => boolean | Promise<boolean>
  /**
   * Project an ACCEPTED `refs/yrd/submit/<branch>` write as a journal fact
   * (branch-is-change phase 2a; @cto efd1fa9a). Called only after git has
   * applied the ref — at post-receive for a direct push, after the drain-time
   * dual-write for a refs/for push, and after birth classification — never
   * before authorize() accepts. Omit and the receiver keeps its pre-2a
   * behaviour: the ref stands in git and nothing downstream can see it.
   */
  branchSubmitted?: (fact: Readonly<{ branch: string; sha: string; base: string }>) => Promise<void>
  /**
   * The inverse fact: a submit ref was deleted by its author (`deleted`) or
   * swept by archival (`archived`). `superseded` is the record lane's takeover
   * of the approval — emitted by the queue's merge bookkeeping
   * (@yrd/queue submitFactRetirement) when a record-lane merge consumes the
   * standing fact; the receiver never emits it.
   */
  branchUnsubmitted?: (fact: Readonly<{ branch: string; reason: "deleted" | "archived" }>) => Promise<void>
}
export type ReceiverDrainResult = {
  delivered: string[]
  failed: Array<{ id: string; error: string }>
  ambiguous: string[]
}

type ReceiverOptions = Readonly<{
  mainRepo: string
  stateDir: string
  process: Pick<Process, "run">
  receiverPath?: string
  inboxDir?: string
  /** Yrd entry the managed hook re-invokes; defaults to declared `mainRepo`'s `bin/yrd`. */
  hookEntry?: string
}>

/**
 * Absolute path to the `bin/yrd` entry of the Yrd checkout that owns THIS module.
 *
 * Used by tests to name the *running* checkout. Production hooks must not use
 * this: a fleet receiver is last-writer-wins across every linked worktree if
 * it re-execs whichever module wrote it (21170's import.meta walk, inverted).
 * The fleet entry is {@link declaredReceiverHookEntry}.
 */
export function defaultReceiverHookEntry(): string {
  let directory = import.meta.dirname
  for (;;) {
    if (existsSync(join(directory, "bin", "yrd"))) return join(directory, "bin", "yrd")
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error(`yrd: receiver: unable to locate the owning Yrd 'bin/yrd' from '${import.meta.dirname}'`)
    }
    directory = parent
  }
}

/**
 * `bin/yrd` under the declared main repository — cto d1af9005 anchor (b).
 * A yrd clone keeps `bin/yrd` at its root; an hh superproject keeps it at
 * `vendor/yrd/bin/yrd`. Missing both is loud; there is no PATH or import.meta
 * fallback, so a slot cannot silently retarget the fleet receiver.
 */
export function declaredReceiverHookEntry(mainRepo: string): string {
  const repo = resolve(mainRepo)
  const direct = join(repo, "bin", "yrd")
  const nested = join(repo, "vendor", "yrd", "bin", "yrd")
  if (existsSync(direct)) return direct
  if (existsSync(nested)) return nested
  throw new Error(`yrd: receiver: declared mainRepo '${repo}' has no bin/yrd (looked at '${direct}' and '${nested}')`)
}

export function receiverHookSource(mode: HookMode, entry: string): string {
  check(entry.length > 0, "receiver hook entry must be a non-empty path")
  return [
    "#!/usr/bin/env bun",
    MANAGED_HOOK_MARKER,
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(entry)}, "receiver-hook", "${mode}"], {`,
    '  stdin: "inherit",',
    '  stdout: "inherit",',
    '  stderr: "inherit",',
    "  env: process.env,",
    "})",
    "process.exit(await child.exited)",
    "",
  ].join("\n")
}

export async function createGitPushReceiver(options: ReceiverOptions): Promise<GitPushReceiver> {
  const hookEntry = options.hookEntry ?? declaredReceiverHookEntry(options.mainRepo)
  const requestedState = resolve(options.stateDir)
  await mkdir(requestedState, { recursive: true, mode: 0o700 })
  const mainRepo = await realpath(resolve(options.mainRepo))
  const stateDir = await realpath(requestedState)
  const receiverPath = resolve(options.receiverPath ?? join(stateDir, "prs.git"))
  const inboxDir = resolve(options.inboxDir ?? join(stateDir, "receiver-inbox"))
  const mainFormat = parseObjectFormat(
    (await mainGit(options.process, mainRepo, ["rev-parse", "--show-object-format"])).stdout,
  )
  const exclusive = createExclusive(join(stateDir, "receiver-init"), { timeoutMs: 30_000, pollIntervalMs: 10 })
  return exclusive.run(async () => {
    const current = await entry(receiverPath)
    check(!current?.isSymbolicLink(), `will not use a symlinked prs.git at '${receiverPath}'`)
    check(current === undefined || current.isDirectory(), `'${receiverPath}' exists and is not a directory`)
    if (current === undefined) {
      await mkdir(dirname(receiverPath), { recursive: true, mode: 0o700 })
      await mkdir(receiverPath, { mode: 0o700 })
      await exec(
        options.process,
        ["git", "init", "--bare", "--initial-branch=main", `--object-format=${mainFormat.objectFormat}`, receiverPath],
        dirname(receiverPath),
      )
    }
    const receiverFormat = await bareFormat(options.process, receiverPath)
    check(
      receiverFormat.objectFormat === mainFormat.objectFormat,
      `object format mismatch: main uses ${mainFormat.objectFormat}, prs.git uses ${receiverFormat.objectFormat}`,
    )
    const receiver = createReceiver({
      version: RECEIVER_VERSION,
      receiverPath,
      mainRepo,
      stateDir,
      inboxDir,
      process: options.process,
      ...receiverFormat,
    })
    await validateBinding(receiver)
    await preflightHooks(receiverPath, hookEntry)
    await mkdir(inboxDir, { recursive: true, mode: 0o700 })
    for (const [key, value] of receiverConfig(receiver)) {
      await receiverGit(receiver, ["config", "--local", key, value])
    }
    if (
      (await mainGit(options.process, mainRepo, ["for-each-ref", "--format=%(refname)", "refs/heads"])).stdout !== ""
    ) {
      await receiverGit(receiver, ["fetch", "--quiet", "--no-tags", mainRepo, "+refs/heads/*:refs/yrd/bases/*"])
    }
    await writeHook(receiverPath, "pre-receive", hookEntry)
    await writeHook(receiverPath, "post-receive", hookEntry)
    return receiver
  }, { holder: "receiver-init" })
}

export async function loadGitPushReceiver(path: string, process: Pick<Process, "run">): Promise<GitPushReceiver> {
  const receiverPath = resolve(path)
  check((await entry(receiverPath))?.isDirectory(), `prs.git is not a real directory at '${receiverPath}'`)
  const format = await bareFormat(process, receiverPath)
  const version = await requiredConfig(process, receiverPath, "yrd.receiverVersion")
  check(version === String(RECEIVER_VERSION), `unsupported receiver version '${version}' at '${receiverPath}'`)
  const receiver = createReceiver({
    version: RECEIVER_VERSION,
    receiverPath,
    mainRepo: resolve(await requiredConfig(process, receiverPath, "yrd.mainRepo")),
    stateDir: resolve(await requiredConfig(process, receiverPath, "yrd.stateDir")),
    inboxDir: resolve(await requiredConfig(process, receiverPath, "yrd.inboxDir")),
    process,
    ...format,
  })
  await mkdir(receiver.inboxDir, { recursive: true, mode: 0o700 })
  return receiver
}

type ReceiverData = Pick<
  GitPushReceiver,
  "version" | "receiverPath" | "mainRepo" | "stateDir" | "inboxDir" | "objectFormat" | "shaLength" | "process"
>

function createReceiver(data: ReceiverData): GitPushReceiver {
  const receiver: GitPushReceiver = Object.freeze({
    ...data,
    prepare: (input, options) => prepareReceiverUpdates(receiver, input, options),
    finalize: (input, options) => finalizeReceiverUpdates(receiver, input, options),
    drain: (options) => drainReceiverInbox(receiver, options),
  })
  return receiver
}

export function parseReceiverUpdates(input: string): ReceiverRefUpdate[] {
  const refs = new Set<string>()
  return input
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(/\s+/u)
      check(parts.length === 3, `malformed receive entry '${entry}'`)
      const [oldSha, newSha, ref] = parts as [string, string, string]
      check(HEX_SHA.test(oldSha) && HEX_SHA.test(newSha), `malformed commit id in receive entry '${entry}'`)
      check(!refs.has(ref), `duplicate update for '${ref}'`)
      refs.add(ref)
      return ReceiverRefUpdateSchema.parse({ oldSha, newSha, ref })
    })
}

async function prepareReceiverUpdates(
  receiver: GitPushReceiver,
  input: string | readonly ReceiverRefUpdate[],
  options: ReceiverHookOptions,
): Promise<ReceiverResult[]> {
  const clock = options.clock ?? systemClock.iso
  const created: string[] = []
  const results: ReceiverResult[] = []
  try {
    for (const value of typeof input === "string" ? parseReceiverUpdates(input) : input) {
      const update = ReceiverRefUpdateSchema.parse(value)
      const authorized = await authorize(receiver, update, options, "before")
      // A submit-ref write/delete or a branch-deletion archival is fully
      // validated here (that IS the point of running at pre-receive), but
      // produces no inbox result: there are no new commits for `intake` to
      // process, only a git ref fact the push itself (or, for archival, the
      // post-receive translation) already carries. See `finalizeReceiverUpdates`
      // for where an "archive" kind performs its actual ref-transaction.
      if (authorized.kind !== "intake") continue
      const result = makeResult(update, authorized, clock)
      const stored = await storeResult(receiver, "prepared", result)
      if (stored.created) created.push(stored.path)
      results.push(result)
    }
    return results
  } catch (cause) {
    for (const path of created) await rm(path, { force: true })
    if (created.length > 0) await syncDir(receiver.inboxDir)
    throw cause
  }
}

async function finalizeReceiverUpdates(
  receiver: GitPushReceiver,
  input: string | readonly ReceiverRefUpdate[],
  options: ReceiverHookOptions,
): Promise<ReceiverResult[]> {
  const clock = options.clock ?? systemClock.iso
  const results: ReceiverResult[] = []
  for (const value of typeof input === "string" ? parseReceiverUpdates(input) : input) {
    const update = ReceiverRefUpdateSchema.parse(value)
    const id = resultId(update)
    const path = resultPath(receiver, "prepared", id)
    let result: ReceiverResult | undefined
    if (await entry(path)) {
      result = await readResult(path, id)
      const stored = updateOf(result)
      check(
        stored.oldSha === update.oldSha && stored.newSha === update.newSha && stored.ref === update.ref,
        `prepared result '${id}' does not match post-receive input`,
      )
      const current = await refValue(receiver, update.ref, options.env)
      check(
        current === update.newSha,
        `post-receive ref '${update.ref}' is ${current ?? "missing"}, expected ${update.newSha}`,
      )
      await validateStored(receiver, result, options)
      // Birth classification rides this same post-receive step, atomic-ish
      // with the creation push itself — see applyCreationClassification's
      // doc. Never a refs/for result (result.change !== undefined): those
      // already submit unconditionally via the drain-time dual-write.
      if (ZERO_SHA.test(result.oldSha) && result.change === undefined) {
        await applyCreationClassification(receiver, update, result.branch, result.intake.base, options)
      }
    } else {
      // No prepared entry exists — either pre-receive never ran (a recovery/
      // direct-call edge case) or this update's `authorize()` never stores one
      // by design (submit-ref, archive). Either way it must be authorized
      // fresh, now against the POST-receive state (`stage: "after"`), before
      // any of its effects — inbox result, or an archival's ref transaction —
      // are allowed to happen.
      const authorized = await authorize(receiver, update, options, "after")
      if (authorized.kind === "archive") {
        // Post-receive is deliberately when this runs: git's own receive-pack
        // has already applied the branch deletion the push requested (see
        // `applyArchival`'s doc for why the hook itself never performs that
        // delete), so the transaction below is racing nothing.
        await applyArchival(receiver, update, authorized.branch, options)
      } else if (authorized.kind === "draft-ref" || authorized.kind === "ignore-ref") {
        // Same reasoning as archival: git already applied THIS ref's own
        // write or delete natively. A deletion (undrafting/unignoring) needs
        // no further action; a create-or-update sweeps the opposite scope
        // namespace for the same branch (mutual exclusion).
        if (!ZERO_SHA.test(update.newSha)) {
          await sweepOppositeScopeRef(
            receiver,
            authorized.kind === "draft-ref" ? "draft" : "ignore",
            authorized.branch,
            options.env,
          )
        }
      } else if (authorized.kind === "intake") {
        result = makeResult(update, authorized, clock)
        await storeResult(receiver, "prepared", result)
        if (ZERO_SHA.test(update.oldSha) && authorized.intent === undefined) {
          await applyCreationClassification(receiver, update, authorized.branch, authorized.target.base, options)
        }
      } else if (authorized.kind === "submit-ref") {
        // git's own ref update already applied the write (or the delete); the
        // only post-receive duty is to project the accepted fact so the queue
        // can see it — before 2a this branch did nothing and a direct submit
        // was invisible to every reader (@yrd/core/22991 phase 2a).
        if (ZERO_SHA.test(update.newSha)) {
          await options.branchUnsubmitted?.({ branch: authorized.branch, reason: "deleted" })
        } else if (authorized.base !== undefined) {
          await options.branchSubmitted?.({ branch: authorized.branch, sha: update.newSha, base: authorized.base })
        }
      }
    }
    if (result !== undefined) {
      await moveResult(receiver, result, "prepared", "pending")
      results.push(result)
    }
  }
  if (options.intake) await receiver.drain({ ...options, intake: options.intake })
  return results
}

async function drainReceiverInbox(
  receiver: GitPushReceiver,
  options: ReceiverHookOptions & { intake: DurableReceiverIntake; lockTimeoutMs?: number },
): Promise<ReceiverDrainResult> {
  await mkdir(receiver.inboxDir, { recursive: true, mode: 0o700 })
  const drain: ReceiverDrainResult = { delivered: [], failed: [], ambiguous: [] }
  const exclusive = createExclusive(join(receiver.inboxDir, "drain-lock"), {
    timeoutMs: options.lockTimeoutMs ?? 0,
    pollIntervalMs: 10,
  })
  return exclusive.run(async () => {
    await recoverPrepared(receiver, options, drain)
    const blocked = new Set<string>()
    for (const { path, result } of await pendingResults(receiver, drain)) {
      if (blocked.has(result.branch)) {
        // Not a failure of its own: an earlier result for this same branch
        // threw in this same drain pass (`blocked.add` sits in that catch,
        // beside the real error). Saying only "blocked" sends the reader
        // hunting for a cause that is already in front of them, in this very
        // result set — and because a failed result stays pending and retries,
        // this line reappears every drain until that first one is dealt with,
        // which reads like a stuck queue rather than one waiting on a fix.
        drain.failed.push({
          id: result.id,
          error:
            `blocked by an earlier failed result for branch '${result.branch}'; that earlier result failed in ` +
            "this same drain and carries the real error — fix that one, and this retries on the next drain",
        })
        continue
      }
      try {
        await validateStored(receiver, result, options)
        await options.intake(result)
        // A `refs/for/` result IS a submission — re-point the submit ref at
        // this tip (dual-write, phase 1: `result.intake.submit` above already
        // carries the fact for the caller's own bay/journal; phase 2 re-points
        // readers here instead). After intake, not before: a failed intake
        // retries the whole result on the next drain, and this write should
        // not have happened for a result nothing downstream has accepted yet.
        if (result.change !== undefined) {
          await writeSubmitRefForCarrier(receiver, result.branch, result.headSha, result.intake.base, options)
        } else if (!ZERO_SHA.test(result.oldSha)) {
          // An ordinary push to an EXISTING branch (never creation — that is
          // `applyCreationClassification`'s job, run atomically with the
          // creation push itself at post-receive, not deferred here). "auto.
          // submit is the express lane... every push to an auto-submit
          // branch submits its exact tip" — lane-ness is re-derived from the
          // CURRENT config on every push, never from whether a submit ref
          // already exists (a manual submit must not turn an unrelated
          // branch into a lane). Draft/ignore/no-match are creation-only by
          // construction: nothing re-checks them on a later push.
          const verdict = await evaluateClassification(receiver, options, result.intake.base, result.branch)
          if (verdict === "submit") {
            await writeSubmitRefForCarrier(receiver, result.branch, result.headSha, result.intake.base, options)
          }
        }
        await rm(path)
        await syncDir(receiver.inboxDir)
        drain.delivered.push(result.id)
      } catch (cause) {
        blocked.add(result.branch)
        drain.failed.push({ id: result.id, error: message(cause) })
      }
    }
    return drain
  }, { holder: "receiver-inbox-drain" })
}

export async function runReceiverHookFromEnvironment(
  mode: HookMode,
  options: ReceiverHookOptions & { input?: string; process: Pick<Process, "run"> },
): Promise<ReceiverResult[]> {
  const env = options.env ?? process.env
  check(env.GIT_DIR, "GIT_DIR is missing in receive-hook environment")
  const receiver = await loadGitPushReceiver(resolve(process.cwd(), env.GIT_DIR), options.process)
  const input = options.input ?? (await Bun.stdin.text())
  if (mode === "pre-receive") return receiver.prepare(input, { ...options, env })
  if (mode === "post-receive") return receiver.finalize(input, { ...options, env })
  throw new Error(`yrd: receiver: unsupported hook mode '${String(mode)}'`)
}

type Result = { code: number; stdout: string; stderr: string }
type ExecOptions = { env?: Environment; allowFailure?: boolean; stdin?: string }
type StoredResult = { path: string; result: ReceiverResult }
const GIT_TIMEOUT_MS = 30_000

function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`yrd: receiver: ${detail}`)
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function code(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined
}

async function exec(
  process: Pick<Process, "run">,
  argv: readonly string[],
  cwd: string,
  options: ExecOptions = {},
): Promise<Result> {
  const completed = await process.run({
    argv,
    cwd,
    env: options.env ?? gitEnv(),
    timeoutMs: GIT_TIMEOUT_MS,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  })
  if (completed.timedOut) throw new Error(`yrd: ${argv.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  const result = { code: completed.exitCode, stdout: completed.stdout.trim(), stderr: completed.stderr.trim() }
  check(
    options.allowFailure || completed.exitCode === 0,
    `${argv.join(" ")} failed: ${result.stderr || result.stdout || `exit ${completed.exitCode}`}`,
  )
  return result
}

function gitEnv(source: Environment = process.env, keepObjects = false): Environment {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        value !== undefined &&
        (!REPOSITORY_ENV.test(key) ||
          (keepObjects && (key === "GIT_OBJECT_DIRECTORY" || key === "GIT_ALTERNATE_OBJECT_DIRECTORIES"))),
    ),
  )
}

async function mainGit(
  process: Pick<Process, "run">,
  repo: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<Result> {
  return exec(process, ["git", "-C", repo, ...args], repo, { ...options, env: gitEnv(options.env) })
}

async function receiverGit(
  receiver: Pick<GitPushReceiver, "receiverPath" | "mainRepo" | "process">,
  args: readonly string[],
  options: ExecOptions & { includeMainObjects?: boolean } = {},
): Promise<Result> {
  const { includeMainObjects, ...rest } = options
  const env = includeMainObjects ? await objectEnv(receiver, options.env) : gitEnv(options.env, true)
  return exec(receiver.process, ["git", `--git-dir=${receiver.receiverPath}`, ...args], receiver.receiverPath, {
    ...rest,
    env,
  })
}

async function objectEnv(
  receiver: Pick<GitPushReceiver, "mainRepo" | "process">,
  source: Environment = process.env,
): Promise<Environment> {
  const objects = resolve(
    receiver.mainRepo,
    (await mainGit(receiver.process, receiver.mainRepo, ["rev-parse", "--git-path", "objects"], { env: source }))
      .stdout,
  )
  const env = gitEnv(source, true)
  const escaped =
    objects.includes(delimiter) || objects.includes('"') || objects.includes("\\") ? JSON.stringify(objects) : objects
  env.GIT_ALTERNATE_OBJECT_DIRECTORIES = [source.GIT_ALTERNATE_OBJECT_DIRECTORIES, escaped]
    .filter(Boolean)
    .join(delimiter)
  return env
}

async function entry(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (cause) {
    if (code(cause) === "ENOENT") return undefined
    throw cause
  }
}

function parseObjectFormat(raw: string): { objectFormat: "sha1" | "sha256"; shaLength: 40 | 64 } {
  check(raw === "sha1" || raw === "sha256", `unsupported Git object format '${raw}'`)
  return raw === "sha1" ? { objectFormat: raw, shaLength: 40 } : { objectFormat: raw, shaLength: 64 }
}

async function bareFormat(
  process: Pick<Process, "run">,
  path: string,
): Promise<{ objectFormat: "sha1" | "sha256"; shaLength: 40 | 64 }> {
  const bare = await exec(process, ["git", `--git-dir=${path}`, "rev-parse", "--is-bare-repository"], path, {
    allowFailure: true,
  })
  check(bare.code === 0 && bare.stdout === "true", `'${path}' exists but is not a bare Git repository`)
  return parseObjectFormat(
    (await exec(process, ["git", `--git-dir=${path}`, "rev-parse", "--show-object-format"], path)).stdout,
  )
}

function receiverConfig(receiver: GitPushReceiver): ReadonlyArray<readonly [string, string]> {
  return [
    ["yrd.receiverVersion", String(RECEIVER_VERSION)],
    ["yrd.stateDir", receiver.stateDir],
    ["yrd.mainRepo", receiver.mainRepo],
    ["yrd.inboxDir", receiver.inboxDir],
    ["receive.advertisePushOptions", "true"],
    // Git-level deletion is allowed; `authorize()` is the actual policy — it
    // translates a `refs/heads/` deletion into archival, allows unsubmitting
    // (`refs/yrd/submit/*` deletion), and refuses everything else, exactly as
    // `receive.denyNonFastForwards: false` already delegates non-fast-forward
    // policy to the hooks rather than a blanket git-level rule.
    ["receive.denyDeletes", "false"],
    ["receive.denyNonFastForwards", "false"],
    ["receive.fsckObjects", "true"],
    ["transfer.fsckObjects", "true"],
    ["core.logAllRefUpdates", "true"],
  ]
}

async function config(process: Pick<Process, "run">, path: string, key: string): Promise<string | undefined> {
  const result = await exec(process, ["git", `--git-dir=${path}`, "config", "--local", "--get", key], path, {
    allowFailure: true,
  })
  check(
    result.code === 0 || (result.code === 1 && result.stdout === ""),
    `cannot read config '${key}': ${result.stderr || result.stdout}`,
  )
  return result.code === 0 ? result.stdout : undefined
}

async function requiredConfig(process: Pick<Process, "run">, path: string, key: string): Promise<string> {
  const value = await config(process, path, key)
  check(value, `'${path}' is missing required config '${key}'`)
  return value
}

type StaleRoot = readonly [key: string, stored: string, fresh: string]

/**
 * Mechanical proof that `mainRepo` is the SAME repository this receiver was
 * already bound to, merely relocated to a new absolute path — never a guess,
 * never a coincidence of matching strings. A moved repository keeps its full
 * commit history byte-identical; this receiver's own object store already
 * holds objects fetched from that history (`refs/yrd/bases/*`, refreshed on
 * every successful bind, plus anything ever pushed through it since). Git
 * object ids are content hashes, so if ANY of `mainRepo`'s current root
 * (parentless) commits already exists as an object here, the two share a
 * genesis an unrelated repository cannot fake. No shared root ⇒ identity is
 * unproven ⇒ the caller must refuse, never self-heal on a hunch.
 */
async function sameRepositoryAcrossMove(
  process: Pick<Process, "run">,
  receiverPath: string,
  mainRepo: string,
): Promise<boolean> {
  const roots = await mainGit(process, mainRepo, ["rev-list", "--max-parents=0", "--all"], { allowFailure: true })
  if (roots.code !== 0) return false
  const shas = roots.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  for (const sha of shas) {
    const has = await exec(
      process,
      ["git", `--git-dir=${receiverPath}`, "cat-file", "-e", `${sha}^{commit}`],
      receiverPath,
      { allowFailure: true },
    )
    if (has.code === 0) return true
  }
  return false
}

/** The loud refusal for a stale-and-unproven binding: both values for every drifted key, plus the exact command that heals it once a human has independently confirmed the two repositories really are the same. */
function staleRootRefusal(receiverPath: string, mainRepo: string, stale: readonly StaleRoot[]): string {
  const heal = stale
    .map(([key, , fresh]) => `git --git-dir="${receiverPath}" config --local ${key} "${fresh}"`)
    .join(" && ")
  return [
    `existing prs.git at '${receiverPath}' already belongs to another repository — no shared commit history with ` +
      `'${mainRepo}' proves otherwise:`,
    ...stale.map(([key, stored, fresh]) => `  ${key}: stored '${stored}', actual '${fresh}'`),
    "if this really is the same repository under a new path (verify manually first), heal it with:",
    `  ${heal}`,
    "otherwise this prs.git belongs to a genuinely different repository — move it aside and let Yrd reinitialize.",
  ].join("\n")
}

async function validateBinding(receiver: GitPushReceiver): Promise<void> {
  const version = await config(receiver.process, receiver.receiverPath, "yrd.receiverVersion")
  const state = await config(receiver.process, receiver.receiverPath, "yrd.stateDir")
  const main = await config(receiver.process, receiver.receiverPath, "yrd.mainRepo")
  const inbox = await config(receiver.process, receiver.receiverPath, "yrd.inboxDir")
  if ([version, state, main, inbox].every((value) => value === undefined)) return
  check(
    version === String(RECEIVER_VERSION) && state && main && inbox,
    "existing prs.git has incomplete or unsupported Yrd receiver configuration",
  )
  const candidates: StaleRoot[] = [
    ["yrd.mainRepo", main, receiver.mainRepo],
    ["yrd.stateDir", state, receiver.stateDir],
    ["yrd.inboxDir", inbox, receiver.inboxDir],
  ]
  const stale = candidates.filter(([, stored, fresh]) => resolve(stored) !== fresh)
  if (stale.length === 0) return
  check(
    await sameRepositoryAcrossMove(receiver.process, receiver.receiverPath, receiver.mainRepo),
    staleRootRefusal(receiver.receiverPath, receiver.mainRepo, stale),
  )
  // Proven, not assumed: log the exact rewrite loudly before the caller's own
  // unconditional `receiverConfig()` write (a few lines below this return, in
  // `createGitPushReceiver`) applies it. No silent acceptance of a dangling
  // path — the operator sees old -> new even when nothing else fails.
  for (const [key, stored, fresh] of stale) {
    console.error(
      `yrd: receiver: self-healing stale '${key}' at '${receiver.receiverPath}': '${stored}' -> '${fresh}' ` +
        `(proven same repository via shared commit history with '${receiver.mainRepo}')`,
    )
  }
}

async function text(path: string): Promise<string | undefined> {
  return (await entry(path)) ? readFile(path, "utf8") : undefined
}

async function preflightHooks(receiverPath: string, entry: string): Promise<void> {
  for (const mode of ["pre-receive", "post-receive"] as const) {
    const path = join(receiverPath, "hooks", mode)
    const body = await text(path)
    check(
      body === undefined || body === receiverHookSource(mode, entry) || body.startsWith(MANAGED_HOOK_PREFIX),
      `will not replace the unmanaged ${mode} hook at '${path}'`,
    )
  }
}

async function writeHook(receiverPath: string, mode: HookMode, entry: string): Promise<void> {
  const hooks = join(receiverPath, "hooks")
  const path = join(hooks, mode)
  const source = receiverHookSource(mode, entry)
  await mkdir(hooks, { recursive: true, mode: 0o700 })
  if ((await text(path)) === source) return chmod(path, 0o755)
  const temporary = await durableTemp(hooks, mode, source, 0o755)
  try {
    await rename(temporary, path)
    await syncDir(hooks)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function durableTemp(directory: string, name: string, body: string, mode: number): Promise<string> {
  const path = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`)
  const file = await open(path, "wx", mode)
  try {
    await file.writeFile(body, "utf8")
    await file.datasync()
  } finally {
    await file.close()
  }
  await chmod(path, mode)
  return path
}

async function syncDir(path: string): Promise<void> {
  const directory = await open(path, "r")
  try {
    await directory.sync()
  } catch (cause) {
    if (code(cause) !== "EINVAL" && code(cause) !== "ENOTSUP") throw cause
  } finally {
    await directory.close()
  }
}

function validSha(sha: string, length: number, label: string, zero = false): void {
  check(
    sha.length === length && HEX_SHA.test(sha) && (zero || !ZERO_SHA.test(sha)),
    `${label} must be a full ${length}-character${zero ? "" : " non-zero"} commit id`,
  )
}

function normalizeTarget(target: ReceiverTarget, receiver: GitPushReceiver): ReceiverTarget {
  const parsed = ReceiverTargetSchema.parse(target)
  validSha(parsed.baseSha, receiver.shaLength, "target baseSha")
  return parsed
}

async function refValue(receiver: GitPushReceiver, ref: string, env?: Environment): Promise<string | null> {
  const output = (await receiverGit(receiver, ["for-each-ref", "--format=%(refname)%00%(objectname)", ref], { env }))
    .stdout
  for (const entry of output.split("\n")) {
    const separator = entry.indexOf("\0")
    if (separator >= 0 && entry.slice(0, separator) === ref) return entry.slice(separator + 1)
  }
  return null
}

/**
 * Appends the caller-supplied intake policy to an authorization refusal. Both
 * refusal sites go through here so the sentence a seat is told can never drift
 * between the push-time check and the drain-time recheck.
 */
function withIntakePolicy(message: string, options: ReceiverHookOptions): string {
  return options.intakePolicy === undefined ? message : `${message}: ${options.intakePolicy}`
}

/**
 * Every `<base>/<change>` reading of a `refs/for/…` ref, longest base first.
 *
 * Both halves can contain slashes, so the split is genuinely ambiguous and the
 * ref alone cannot resolve it — `refs/for/main/@yrd/core/p2` reads four ways.
 * Gerrit disambiguates by taking the longest base that is an existing branch,
 * and so do we: this returns the candidates in that order and the caller,
 * which can reach a repository, picks the first that resolves.
 *
 * Empty on anything outside the namespace, and on a ref that names a base but
 * no change — `refs/for/main` is not a submit, it is a mistake, and it must be
 * refused rather than silently read as a branch push.
 */
export function submitRefSplits(ref: string): Array<{ base: string; name: string }> {
  if (!ref.startsWith(SUBMIT_PREFIX)) return []
  const rest = ref.slice(SUBMIT_PREFIX.length)
  const splits: Array<{ base: string; name: string }> = []
  for (let cut = rest.lastIndexOf("/"); cut > 0; cut = rest.lastIndexOf("/", cut - 1)) {
    splits.push({ base: rest.slice(0, cut), name: rest.slice(cut + 1) })
  }
  return splits
}

/**
 * Resolves a submit ref against the base branches that actually exist.
 *
 * Base existence is asked of the MAIN repository, which is where `validatePin`
 * already resolves `target.base` — one source of truth for "what is a base",
 * so a ref cannot be admitted against a base the pin check would then reject.
 */
async function submitIntent(receiver: GitPushReceiver, ref: string, env?: Environment): Promise<ReceiverSubmitIntent> {
  const splits = submitRefSplits(ref)
  check(
    splits.length > 0,
    `submit ref '${ref}' names no change; push to 'refs/for/<base>/<change>' where <change> is the issue reference`,
  )
  for (const split of splits) {
    const found = await mainGit(
      receiver.process,
      receiver.mainRepo,
      ["rev-parse", "--verify", `refs/heads/${split.base}^{commit}`],
      { env, allowFailure: true },
    )
    if (found.code === 0) return { base: split.base, name: split.name }
  }
  check(
    false,
    `submit ref '${ref}' names no base branch that exists; tried ${splits.map((split) => `'${split.base}'`).join(", ")}; ` +
      "push to 'refs/for/<base>/<change>' with a base branch that exists",
  )
}

async function validBranch(receiver: GitPushReceiver, branch: string, label: string): Promise<void> {
  const result = await receiverGit(receiver, ["check-ref-format", "--branch", branch], { allowFailure: true })
  check(result.code === 0, `invalid ${label} '${branch}'`)
}

async function validatePin(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  target: ReceiverTarget,
  env?: Environment,
): Promise<void> {
  const current = await mainGit(
    receiver.process,
    receiver.mainRepo,
    ["rev-parse", "--verify", `refs/heads/${target.base}^{commit}`],
    {
      env,
      allowFailure: true,
    },
  )
  check(current.code === 0, `base branch '${target.base}' does not resolve in the main repository`)
  const pinned = await mainGit(
    receiver.process,
    receiver.mainRepo,
    ["merge-base", "--is-ancestor", target.baseSha, current.stdout],
    {
      env,
      allowFailure: true,
    },
  )
  check(
    pinned.code === 0,
    `pinned base ${target.baseSha.slice(0, 12)} is not in the history of base branch '${target.base}'; ` +
      `rebase the change onto '${target.base}' and push again`,
  )
  const descends = await receiverGit(receiver, ["merge-base", "--is-ancestor", target.baseSha, update.newSha], {
    env,
    allowFailure: true,
    includeMainObjects: true,
  })
  check(
    descends.code === 0,
    `pushed head ${update.newSha.slice(0, 12)} does not descend from pinned base ` +
      `${target.baseSha.slice(0, 12)}; rebase the change onto '${target.base}' and push again`,
  )
}

async function validateSubmitCarrier(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  branch: string,
  env?: Environment,
): Promise<void> {
  const exact = `refs/heads/${branch}`
  const output = await mainGit(receiver.process, receiver.mainRepo, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
    exact,
  ])
  const current = output.stdout
    .split("\n")
    .map((line) => line.split("\0"))
    .find(([ref]) => ref === exact)?.[1]
  if (current === undefined) return
  const descends = await receiverGit(receiver, ["merge-base", "--is-ancestor", current, update.newSha], {
    env,
    allowFailure: true,
    includeMainObjects: true,
  })
  check(
    descends.code === 0,
    `carrier '${branch}' is at ${current.slice(0, 12)}, which the pushed head ` +
      `${update.newSha.slice(0, 12)} does not descend from; rebase the change onto it and push again`,
  )
}

/**
 * Push-time half of the derived lane's identity contract (S6): a
 * `refs/for/<base>/<change>` push with no live record IS the whole
 * submission, and the derived member's identity is read at admission from
 * the tip commit's `Change-Id` trailer — so a tip without a valid trailer
 * refuses HERE, where every other refs/for refusal fires, never at admission
 * after the pusher has already seen success (the receiver doc's standing
 * promise). A carrier a live record owns is exempt: the record lane derives
 * identity internally, and a grandfathered re-push carries none of the
 * derived lane's obligations. Trailer shape and parsing are shared with the
 * enrichment reader via `change-identity.ts` — one source of truth, so the
 * gate can never accept a trailer admission would then fail to read.
 * `includeMainObjects` for the same reason as the ancestry checks above: at
 * pre-receive the pushed commit lives only in the receiver's quarantine.
 */
async function validateChangeIdTrailer(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  branch: string,
  options: ReceiverHookOptions,
): Promise<void> {
  if ((await options.recordOwnsBranch?.(branch)) === true) return
  const raw = (
    await receiverGit(
      receiver,
      ["show", "-s", `--format=%(trailers:key=${CHANGE_ID_TRAILER_KEY},valueonly,separator=%x2c)`, update.newSha],
      { env: options.env, includeMainObjects: true },
    )
  ).stdout
  const candidates = changeIdTrailerCandidates(raw)
  if (findChangeId(candidates) !== undefined) return
  const found =
    candidates.length === 0
      ? `has no '${CHANGE_ID_TRAILER_KEY}' trailer, which is the change's identity at admission`
      : `has no valid '${CHANGE_ID_TRAILER_KEY}' trailer — found '${candidates.join("', '")}', not 'I' followed by 40 hex digits`
  // The cure has to be one the reader can actually run. The first cut said only
  // "amend the commit message to end with a trailer line … (`git commit
  // --amend`)" — and a bare amend does not ADD a trailer, because nothing in a
  // plain checkout generates one. A reader following it literally amends,
  // pushes, reads the same refusal, and amends again. Measured twice: @chief on
  // task/check-reachability-fix (2026-08-27) and again on tip 0ef8319
  // (2026-08-28), both of whom ended up computing the 40 hex digits by hand
  // (@i/10-yrd/23139 — a remedy is only a remedy if its reader can execute it).
  // So the missing case now names what GENERATES the value: the repository's
  // commit-msg hook, how to tell whether your checkout runs it, and a one-liner
  // that works without one. The malformed case keeps the plain correction,
  // which was always executable — the author already wrote the line.
  const cure =
    candidates.length === 0
      ? "the repository's commit-msg hook stamps this trailer, so `git commit --amend --no-edit` adds one; " +
        "if the message comes back unchanged your checkout is not running that hook (check `git config " +
        'core.hooksPath`), and `git commit --amend --trailer "Change-Id: ' +
        'I$(git rev-parse HEAD | sha1sum | cut -c1-40)"` writes one without it'
      : "correct the trailer line to 'Change-Id: I<40 hex>' (`git commit --amend`)"
  check(
    false,
    `refs/for submit '${update.ref}': tip commit ${update.newSha.slice(0, 12)} ${found}; ${cure}, then push again`,
  )
}

/**
 * The pushed head's `.yrd.yml`, or undefined when that revision's tree has
 * none. `includeMainObjects` matters here exactly as it does for the ancestry
 * checks above: at pre-receive the pushed blob lives only in the receiver's
 * quarantine, not yet in the main repository's object store.
 */
async function readPushedBlob(
  receiver: GitPushReceiver,
  sha: string,
  path: string,
  env?: Environment,
): Promise<string | undefined> {
  const object = `${sha}:${path}`
  const exists = await receiverGit(receiver, ["cat-file", "-e", object], {
    env,
    allowFailure: true,
    includeMainObjects: true,
  })
  if (exists.code !== 0) return undefined
  return (await receiverGit(receiver, ["show", object], { env, includeMainObjects: true })).stdout
}

/**
 * Config admission: read the pushed head's `.yrd.yml` and hand it to whatever
 * schema the caller owns (@yrd/bay cannot import @yrd/cli's parser without a
 * dependency cycle — the receiver only ever reads the blob). Runs at BOTH
 * pre-receive and post-receive, same as `validatePin`/`validateSubmitCarrier`
 * above, so a config the base's own queue schema would refuse is rejected at
 * the push itself — the same "unmergeable" guarantee those two already give
 * gitlink pins and carrier ancestry, closing the gap PR1337 fell through
 * (typecheck, lockfile and manifest gates all passed; nothing ever asked
 * whether the pushed .yrd.yml itself would parse).
 *
 * `options.validateConfig` is optional and additive: a caller that has not
 * wired a schema in yet keeps today's unjudged behavior exactly.
 */
async function validateQueueConfig(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  options: ReceiverHookOptions,
): Promise<void> {
  if (options.validateConfig === undefined) return
  await options.validateConfig(await readPushedBlob(receiver, update.newSha, ".yrd.yml", options.env))
}

/**
 * The generic "did this ref actually move the way the push claims" check,
 * applicable to any ref this receiver accepts — intake branches, `refs/for`
 * submits, `refs/yrd/submit/*`, and a `refs/heads/*` deletion alike. Not a
 * reimplementation of git's own old-value CAS (git already refuses the wire
 * update if the ref moved out from under it); this is the receiver's own
 * belt-and-suspenders re-read, run at both hook stages like every other check
 * in `authorize()`, and — now that deletion is a real, accepted outcome —
 * correctly normalizes a zero sha to "no ref" on EITHER side of the update.
 */
async function checkNotStale(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  stage: "before" | "after",
  env?: Environment,
): Promise<void> {
  const current = await refValue(receiver, update.ref, env)
  const relevant = stage === "after" ? update.newSha : update.oldSha
  const expected = ZERO_SHA.test(relevant) ? null : relevant
  check(
    current === expected,
    `stale ${stage === "before" ? "push" : "post-receive"} for '${update.ref}': expected ${expected ?? "no ref"}, found ${current ?? "no ref"}`,
  )
}

/**
 * The two structural facts a `refs/yrd/submit/<branch>` write must satisfy
 * (bead-branch-is-change): (a) reachable from the branch's own current tip —
 * a submit approves a commit that was actually pushed, not one invented out
 * of thin air — and (b) not already an ancestor of the base branch — a submit
 * approves work still worth merging, not history already on main. The two
 * failures are named distinctly per the model doc ("a dangling sha and an
 * already-landed sha are different refusals"). Deletion (unsubmit) skips this
 * entirely — retracting an approval is unconditional, and git's own old-value
 * CAS on the ref update is all the locking it needs.
 */
async function validateSubmitRefValue(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  branch: string,
  options: ReceiverHookOptions,
): Promise<string> {
  const branchTip = await refValue(receiver, `${BRANCH_PREFIX}${branch}`, options.env)
  check(
    branchTip !== null,
    `submit ref '${update.ref}' names ${update.newSha.slice(0, 12)} but branch '${branch}' has no ref in this repository; push the branch before submitting it`,
  )
  const reachable = await receiverGit(receiver, ["merge-base", "--is-ancestor", update.newSha, branchTip], {
    env: options.env,
    allowFailure: true,
  })
  check(
    reachable.code === 0,
    `submit ref '${update.ref}' names ${update.newSha.slice(0, 12)}, which is not reachable from branch ` +
      `'${branch}''s current tip ${branchTip.slice(0, 12)} (equal or an ancestor); push the branch first`,
  )
  const resolved = await options.resolveTarget(branch, update, undefined)
  check(resolved, withIntakePolicy(`branch '${branch}' is not authorized for Yrd intake`, options))
  const target = normalizeTarget(resolved, receiver)
  await validBranch(receiver, target.base, "base branch")
  const baseTip = await mainGit(
    receiver.process,
    receiver.mainRepo,
    ["rev-parse", "--verify", `refs/heads/${target.base}^{commit}`],
    { env: options.env, allowFailure: true },
  )
  check(baseTip.code === 0, `base branch '${target.base}' does not resolve in the main repository`)
  const merged = await receiverGit(receiver, ["merge-base", "--is-ancestor", update.newSha, baseTip.stdout], {
    env: options.env,
    allowFailure: true,
    includeMainObjects: true,
  })
  check(
    merged.code !== 0,
    `submit ref '${update.ref}' names ${update.newSha.slice(0, 12)}, which is already an ancestor of base branch '${target.base}'; nothing left to submit`,
  )
  return target.base
}

/**
 * Whether `sha` is already an ancestor of `base`'s CURRENT tip in the main
 * repository — "nothing left to submit", the same fact `validateSubmitRefValue`
 * refuses a direct submit push for above. `validateSubmitRefValue` keeps its
 * own inline computation (already shipped, already tested, and it needs a
 * DISTINCT refusal message when the base fails to resolve at all); this
 * standalone boolean is for callers that respond to the SAME fact with
 * something other than a refusal — silence (`applyCreationClassification`'s
 * no-op guard) or a different refusal entirely (`isSubmitLive` below).
 */
async function isAncestorOfBase(
  receiver: GitPushReceiver,
  sha: string,
  base: string,
  env?: Environment,
): Promise<boolean> {
  const baseTip = await mainGit(
    receiver.process,
    receiver.mainRepo,
    ["rev-parse", "--verify", `refs/heads/${base}^{commit}`],
    { env, allowFailure: true },
  )
  if (baseTip.code !== 0) return false
  const merged = await receiverGit(receiver, ["merge-base", "--is-ancestor", sha, baseTip.stdout], {
    env,
    allowFailure: true,
    includeMainObjects: true,
  })
  return merged.code === 0
}

/**
 * Whether `refs/yrd/submit/<branch>` is LIVE right now, the model doc's own
 * definition verbatim: reachable from the branch's current tip AND not yet
 * an ancestor of its resolved base. Used only by the ignore-refusal check in
 * `authorize()` ("submitted work can never be hidden") — a merged submit is
 * not live, so ignoring a branch whose only submit already merged is fine,
 * the same way the model doc treats "merged" as no longer needing protection.
 * If the base cannot be resolved at all (no bay tracks this branch any more),
 * this reads as NOT live rather than refusing blind on an unprovable fact —
 * erring toward allowing the ignore over inventing a refusal from a base this
 * function cannot even name.
 */
async function isSubmitLive(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  options: ReceiverHookOptions,
  branch: string,
  submitSha: string,
): Promise<boolean> {
  const branchTip = await refValue(receiver, `${BRANCH_PREFIX}${branch}`, options.env)
  if (branchTip === null) return false
  const reachable = await receiverGit(receiver, ["merge-base", "--is-ancestor", submitSha, branchTip], {
    env: options.env,
    allowFailure: true,
  })
  if (reachable.code !== 0) return false
  const resolved = await options.resolveTarget(branch, update, undefined)
  if (!resolved) return false
  const target = normalizeTarget(resolved, receiver)
  return !(await isAncestorOfBase(receiver, submitSha, target.base, options.env))
}

/**
 * The archive shelf name a deleted branch merges on — the branch as a path
 * PREFIX, the archived commit's FULL sha as the final segment (review-panel
 * revision of the original `<branch>-<shortsha>` suffix format; amends the
 * shape merged in phase 1a). Two collision classes this kills structurally,
 * not just probabilistically: re-archiving a branch at IDENTICAL content (the
 * full path is then byte-identical too — see `applyArchival`'s `update`, not
 * `create`, for why that is now a legal no-op rather than a refusal) and a
 * branch name that happens to look like another branch's shortened archive
 * suffix (the branch is now an exact path SEGMENT, never a string
 * concatenated with a hyphen — git's own ref hierarchy disambiguates it).
 * Also makes every archival of one branch name naturally enumerable:
 * `for-each-ref refs/yrd/archive/<branch>` lists every episode. Centralized
 * so `applyArchival` is the only place that computes it.
 */
function archiveRefFor(branch: string, oldSha: string): string {
  return `${ARCHIVE_REF_PREFIX}${branch}/${oldSha}`
}

/**
 * The archival translation itself, run at post-receive once git has already
 * applied the branch deletion the push requested. One atomic
 * `git update-ref --stdin` transaction (verified empirically: a plain
 * multi-line batch, and explicitly with `start`/`prepare`/`commit`, both
 * apply all-or-nothing — a bad or unmet command anywhere in the batch leaves
 * every ref in the batch untouched) that:
 *
 *   - sets the archive shelf entry to the branch's old tip. `update`, not
 *     `create`: because the ref's own path now embeds the full sha
 *     (`archiveRefFor`), re-archiving IDENTICAL content targets the exact
 *     same ref at the exact same value — legal, a no-op "newest wins" move,
 *     never a collision to refuse. `update` with no old-value also succeeds
 *     on a ref that does not exist yet, so ordinary (non-identical) archival
 *     is unaffected — verified empirically both ways before wiring this in,
 *   - VERIFIES (never deletes) that `refs/heads/<branch>` is gone — git's own
 *     receive-pack already deleted it as part of accepting this push, before
 *     post-receive ever runs; doing that deletion here too, or doing it in
 *     pre-receive to "help", would race git's own ref transaction (whichever
 *     writes second finds a value that no longer matches its expected old
 *     value and fails) — so this only asserts the fact and aborts the whole
 *     transaction loudly if it somehow does not hold, rather than archiving a
 *     branch that is still alive,
 *   - sweeps a live submit ref for the same branch, if one exists,
 *   - sweeps a live draft or ignore ref for the same branch, if either exists
 *     (phase 1b: archival ends every decision this branch was carrying, not
 *     only its approval — an archived branch's scope markers are as stale as
 *     its submit).
 *
 * `delete <ref> <old>` on an already-nonexistent ref fails ("does not
 * exist") rather than no-op'ing — confirmed empirically — which is exactly
 * why the branch ref gets `verify`, and why every sweep's delete line is
 * included only when a current value was actually read.
 */
async function applyArchival(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  branch: string,
  options: ReceiverHookOptions,
): Promise<void> {
  const env = options.env
  const archiveRef = archiveRefFor(branch, update.oldSha)
  // Read every sweepable ref's current value BEFORE building the transaction,
  // same reasoning as the original submit-only sweep: only a ref that
  // actually exists gets a `delete` line, and its old-value is the CAS that
  // makes the delete safe against a concurrent write.
  const current = await Promise.all(
    [SUBMIT_REF_PREFIX, DRAFT_REF_PREFIX, IGNORE_REF_PREFIX].map(async (prefix) => {
      const ref = `${prefix}${branch}`
      return [ref, await refValue(receiver, ref, env)] as const
    }),
  )
  const zero = "0".repeat(receiver.shaLength)
  const commands = [
    "start",
    `update ${archiveRef} ${update.oldSha}`,
    `verify ${BRANCH_PREFIX}${branch} ${zero}`,
    ...current.flatMap(([ref, value]) => (value === null ? [] : [`delete ${ref} ${value}`])),
    "prepare",
    "commit",
    "",
  ].join("\n")
  await receiverGit(receiver, ["update-ref", "--stdin"], { env, stdin: commands })
  // The sweep just cleared the submit ref along with the branch; say so to the
  // projection — the shelf keeps the bytes, the approval is gone (phase 2a).
  if (current.some(([ref, value]) => ref.startsWith(SUBMIT_REF_PREFIX) && value !== null)) {
    await options.branchUnsubmitted?.({ branch, reason: "archived" })
  }
}

/**
 * Every `refs/for/<base>/<change>` push re-submits its tip (model doc: "push
 * IS submit" applies on every push, not just the first). Dual-written
 * alongside the existing `result.intake.submit` fact this drain step already
 * records for the caller's own bay/journal — phase 1 keeps both writes; phase
 * 2 re-points readers at this ref alone. No CAS against the ref's previous
 * value: a fresh submission supersedes whatever was submitted before, or
 * nothing at all, unconditionally.
 */
async function writeSubmitRefForCarrier(
  receiver: GitPushReceiver,
  branch: string,
  headSha: string,
  base: string,
  options: ReceiverHookOptions,
): Promise<void> {
  await receiverGit(receiver, ["update-ref", `${SUBMIT_REF_PREFIX}${branch}`, headSha], { env: options.env })
  // The ref is the fact; the projection follows it (phase 2a). Emitted AFTER
  // the write so the journal never claims an approval git does not hold.
  await options.branchSubmitted?.({ branch, sha: headSha, base })
}

/**
 * Draft and ignore are mutually exclusive per branch (bead-branch-is-change,
 * "Scope"): accepting a write to one clears the other for the SAME branch.
 * The requested ref's own write already merged via git's native receive-pack
 * by the time this runs (post-receive, same timing as `applyArchival`) — this
 * only performs the EXTRA half, a single atomic delete of whichever ref the
 * opposite namespace holds, CAS'd on its current value so a concurrent writer
 * to that namespace is a loud failure rather than a lost update. A single
 * `update-ref -d` is already one atomic operation; there is nothing else to
 * batch it with (unlike archival's three-way transaction), so no --stdin here.
 */
async function sweepOppositeScopeRef(
  receiver: GitPushReceiver,
  kind: "draft" | "ignore",
  branch: string,
  env?: Environment,
): Promise<void> {
  const opposite = `${kind === "draft" ? IGNORE_REF_PREFIX : DRAFT_REF_PREFIX}${branch}`
  const current = await refValue(receiver, opposite, env)
  if (current === null) return
  await receiverGit(receiver, ["update-ref", "-d", opposite, current], { env })
}

/**
 * The BASE branch's own `.yrd.yml`, or undefined when that branch's tree has
 * none — the authority config for scope classification, deliberately NOT the
 * pushed head's own (that would let a first push classify itself, and is
 * `readPushedBlob`'s separate job for the admission gate). Mirrors
 * `readConfigFromBase` in `@yrd/cli/host.ts`: resolve the base's current tip
 * in the MAIN repository, then read the blob there — the base is already
 * merged, so unlike `readPushedBlob` this never needs the receiver's own
 * quarantine object access.
 */
async function readBaseBlob(
  receiver: GitPushReceiver,
  base: string,
  path: string,
  env?: Environment,
): Promise<string | undefined> {
  const resolved = await mainGit(
    receiver.process,
    receiver.mainRepo,
    ["rev-parse", "--verify", `refs/heads/${base}^{commit}`],
    { env, allowFailure: true },
  )
  check(resolved.code === 0, `base branch '${base}' does not resolve in the main repository`)
  const object = `${resolved.stdout}:${path}`
  const exists = await mainGit(receiver.process, receiver.mainRepo, ["cat-file", "-e", object], {
    env,
    allowFailure: true,
  })
  if (exists.code !== 0) return undefined
  return (await mainGit(receiver.process, receiver.mainRepo, ["show", object], { env })).stdout
}

/**
 * Classify one branch via the caller's injected classifier, or undefined when
 * none is wired (additive, like `validateConfig`). Reads the BASE's config
 * fresh on every call — callers decide how often to call it; nothing here
 * caches. Called from two different places for two different questions:
 * `applyCreationClassification` (birth classification, creation only — "config
 * edits never reclassify existing branches" is enforced entirely by never
 * calling this again for an existing branch's draft/ignore fate) and
 * `drainReceiverInbox`'s ongoing lane check (submit only, re-evaluated on
 * every later push — the ONE part of classification that is deliberately NOT
 * creation-only, by explicit design).
 */
async function evaluateClassification(
  receiver: GitPushReceiver,
  options: ReceiverHookOptions,
  base: string,
  branch: string,
): Promise<ReceiverAutoClassification | undefined> {
  if (options.classifyBranch === undefined) return undefined
  const yaml = await readBaseBlob(receiver, base, ".yrd.yml", options.env)
  return options.classifyBranch(yaml, branch)
}

/**
 * Birth classification: materializes the `auto:` block's verdict for a
 * branch at the moment of its creation, at POST-RECEIVE — the same timing as
 * `applyArchival`, run immediately after git's own receive-pack has already
 * accepted the branch-creation push, not deferred to a later drain(). Review
 * panel: "a crash must never leave a created-but-unclassified branch" — this
 * is the same narrowing `applyArchival` already gives archival (a bounded,
 * disclosed residual crash window within one receive-pack process's
 * lifetime, not a full durability guarantee), now applied to classification
 * too, in place of the original design where classification only happened
 * if and when a LATER `drain()` call with `intake` succeeded — an unbounded
 * wait with no guarantee it ever ran at all.
 *
 * An ignore verdict materializes the ignore ref; a submit verdict
 * materializes the submit ref UNLESS the pushed tip is already an ancestor of
 * the base — the same "nothing left to submit" no-op rule
 * `validateSubmitRefValue` already enforces (as a refusal) for a direct
 * submit push, reused here as a silent skip: a branch creation must never be
 * refused merely because its content happens to already be on main. A draft
 * verdict, or no match at all, writes nothing — draft is the default
 * (tracked, no ref) and no-match is untracked.
 */
async function applyCreationClassification(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  branch: string,
  base: string,
  options: ReceiverHookOptions,
): Promise<void> {
  const verdict = await evaluateClassification(receiver, options, base, branch)
  if (verdict === "ignore") {
    await receiverGit(receiver, ["update-ref", `${IGNORE_REF_PREFIX}${branch}`, update.newSha], { env: options.env })
  } else if (verdict === "submit") {
    if (await isAncestorOfBase(receiver, update.newSha, base, options.env)) return
    await writeSubmitRefForCarrier(receiver, branch, update.newSha, base, options)
  }
}

type AuthorizedUpdate =
  | Readonly<{ kind: "intake"; branch: string; target: ReceiverTarget; intent?: ReceiverSubmitIntent }>
  | Readonly<{ kind: "submit-ref"; branch: string; base?: string }>
  | Readonly<{ kind: "archive"; branch: string }>
  | Readonly<{ kind: "draft-ref" | "ignore-ref"; branch: string }>

async function authorize(
  receiver: GitPushReceiver,
  update: ReceiverRefUpdate,
  options: ReceiverHookOptions,
  stage: "before" | "after",
): Promise<AuthorizedUpdate> {
  validSha(update.oldSha, receiver.shaLength, "old commit id", true)
  validSha(update.newSha, receiver.shaLength, "new commit id", true)
  const deleting = ZERO_SHA.test(update.newSha)

  // The shelf is permanent: written only by `applyArchival` translating a
  // branch deletion, never by a direct push in either direction.
  check(
    !update.ref.startsWith(ARCHIVE_REF_PREFIX),
    `refs under '${ARCHIVE_REF_PREFIX}' are the archive shelf; they are written only by archiving a branch ` +
      `(deleting its '${BRANCH_PREFIX}' ref), never by a direct push`,
  )

  for (const [prefix, label, kind] of [
    [DRAFT_REF_PREFIX, "draft", "draft-ref"],
    [IGNORE_REF_PREFIX, "ignore", "ignore-ref"],
  ] as const) {
    if (!update.ref.startsWith(prefix)) continue
    const branch = update.ref.slice(prefix.length)
    check(branch.length > 0, `${label} ref '${update.ref}' names no branch`)
    await validBranch(receiver, branch, `${label} branch`)
    await checkNotStale(receiver, update, stage, options.env)
    // Existence, never reachability: "value largely irrelevant; existence is
    // the fact" (phase 1b spec) — unlike submit, a draft/ignore write carries
    // no approval semantics to validate against the branch's own history.
    if (!deleting) {
      const branchTip = await refValue(receiver, `${BRANCH_PREFIX}${branch}`, options.env)
      check(
        branchTip !== null,
        `${label} ref '${update.ref}' names branch '${branch}', which has no ref in this repository`,
      )
      // "Submitted work can never be hidden" (review panel, phase 1b): ignore
      // is a SCOPE decision, not an unsubmit, and must not silently make an
      // approved change invisible. Draft carries no such rule — draft and
      // submit are not mutually exclusive on any axis.
      if (kind === "ignore-ref") {
        const submitSha = await refValue(receiver, `${SUBMIT_REF_PREFIX}${branch}`, options.env)
        if (submitSha !== null && (await isSubmitLive(receiver, update, options, branch, submitSha))) {
          check(
            false,
            `cannot ignore branch '${branch}': a live submit ${submitSha.slice(0, 12)} exists on it; submitted work can never be hidden — unsubmit it first`,
          )
        }
      }
    }
    return { kind, branch }
  }

  if (update.ref.startsWith(SUBMIT_REF_PREFIX)) {
    const branch = update.ref.slice(SUBMIT_REF_PREFIX.length)
    check(branch.length > 0, `submit ref '${update.ref}' names no branch`)
    await validBranch(receiver, branch, "submit branch")
    await checkNotStale(receiver, update, stage, options.env)
    if (deleting) return { kind: "submit-ref", branch }
    const base = await validateSubmitRefValue(receiver, update, branch, options)
    return { kind: "submit-ref", branch, base }
  }

  const isSubmit = update.ref.startsWith(SUBMIT_PREFIX)
  const isBranch = update.ref.startsWith(BRANCH_PREFIX) && update.ref.length > BRANCH_PREFIX.length
  check(
    isSubmit || isBranch,
    `only branch refs under ${BRANCH_PREFIX}, submit refs under ${SUBMIT_PREFIX} or ${SUBMIT_REF_PREFIX}, and ` +
      `scope refs under ${DRAFT_REF_PREFIX} or ${IGNORE_REF_PREFIX} are accepted, got '${update.ref}'`,
  )

  // A branch deletion translates to archival instead of merging on the
  // intake path below — there are no new commits here for intake to process,
  // only a branch that stops existing under `refs/heads/` and starts existing
  // under `refs/yrd/archive/` instead. No precondition to check beyond
  // authorization: since the archive ref's own path embeds the full sha
  // (`archiveRefFor`), there is no longer a name collision `applyArchival`'s
  // transaction could hit — re-archiving identical content is a legal no-op.
  if (isBranch && deleting) {
    const branch = update.ref.slice(BRANCH_PREFIX.length)
    const resolved = await options.resolveTarget(branch, update, undefined)
    check(resolved, withIntakePolicy(`branch '${branch}' is not authorized for Yrd intake`, options))
    await validBranch(receiver, branch, "intake branch")
    await checkNotStale(receiver, update, stage, options.env)
    return { kind: "archive", branch }
  }

  check(!deleting, `ref deletion is not accepted for '${update.ref}'`)

  // A submit push predates its bay by construction, so it cannot be authorized
  // by "an active bay tracks this branch" — the ref carries the intent instead,
  // and the resolver's job becomes opening the bay rather than finding one.
  const intent = isSubmit ? await submitIntent(receiver, update.ref, options.env) : undefined
  const resolved = await options.resolveTarget(
    intent === undefined ? update.ref.slice(BRANCH_PREFIX.length) : intent.name,
    update,
    intent,
  )
  const subject =
    intent === undefined ? `branch '${update.ref.slice(BRANCH_PREFIX.length)}'` : `change '${intent.name}'`
  check(resolved, withIntakePolicy(`${subject} is not authorized for Yrd intake`, options))
  const branch = intent === undefined ? update.ref.slice(BRANCH_PREFIX.length) : resolved.branch
  check(
    branch !== undefined,
    `submit ref '${update.ref}' was admitted without a carrier branch; the resolver must name the branch the change merges on`,
  )
  await validBranch(receiver, branch, "intake branch")
  const target = normalizeTarget(resolved, receiver)
  await validBranch(receiver, target.base, "base branch")
  // The ref and the resolver must agree about where this merges. They are two
  // independent statements of the same fact, and a disagreement means the
  // change would gate against a base its author never named.
  check(
    intent === undefined || target.base === intent.base,
    `submit ref '${update.ref}' targets base '${intent?.base ?? ""}' but intake resolved base '${target.base}'`,
  )
  await checkNotStale(receiver, update, stage, options.env)
  await validatePin(receiver, update, target, options.env)
  if (intent !== undefined) {
    await validateSubmitCarrier(receiver, update, branch, options.env)
    await validateChangeIdTrailer(receiver, update, branch, options)
  }
  await validateQueueConfig(receiver, update, options)
  return intent === undefined ? { kind: "intake", branch, target } : { kind: "intake", branch, target, intent }
}

function resultId(update: ReceiverRefUpdate): string {
  return createHash("sha256").update(`${update.ref}\0${update.oldSha}\0${update.newSha}`).digest("hex")
}

function makeResult(
  update: ReceiverRefUpdate,
  authorized: Readonly<{ kind: "intake"; branch: string; target: ReceiverTarget; intent?: ReceiverSubmitIntent }>,
  clock: () => string,
): ReceiverResult {
  const { branch, target, intent } = authorized
  return {
    version: RESULT_VERSION,
    id: resultId(update),
    receivedAt: clock(),
    ref: update.ref,
    branch,
    ...(intent === undefined ? {} : { change: intent.name }),
    oldSha: update.oldSha,
    headSha: update.newSha,
    intake: {
      ...target,
      branch,
      headSha: update.newSha,
      ...(intent === undefined ? {} : { submit: true as const }),
    },
  }
}

function updateOf(result: ReceiverResult): ReceiverRefUpdate {
  return { oldSha: result.oldSha, newSha: result.headSha, ref: result.ref }
}

function resultPath(receiver: GitPushReceiver, state: ResultState, id: string): string {
  return join(receiver.inboxDir, `${id}.${state}.json`)
}

function sameResult(existing: ReceiverResult, expected: ReceiverResult, path: string): void {
  check(
    JSON.stringify({ ...existing, receivedAt: undefined }) === JSON.stringify({ ...expected, receivedAt: undefined }),
    `result collision at '${path}'`,
  )
}

async function linkResult(source: string, destination: string, result: ReceiverResult): Promise<boolean> {
  try {
    await link(source, destination)
    return true
  } catch (cause) {
    if (code(cause) !== "EEXIST") throw cause
    sameResult(await readResult(destination, result.id), result, destination)
    return false
  }
}

async function storeResult(
  receiver: GitPushReceiver,
  state: ResultState,
  result: ReceiverResult,
): Promise<{ path: string; created: boolean }> {
  const path = resultPath(receiver, state, result.id)
  if (await entry(path)) {
    sameResult(await readResult(path, result.id), result, path)
    return { path, created: false }
  }
  const temporary = await durableTemp(receiver.inboxDir, result.id, `${JSON.stringify(result)}\n`, 0o600)
  try {
    const created = await linkResult(temporary, path, result)
    if (created) await syncDir(receiver.inboxDir)
    return { path, created }
  } finally {
    await rm(temporary, { force: true })
  }
}

function validateResult(value: unknown, id: string, path: string): ReceiverResult {
  const parsed = ReceiverResultSchema.safeParse(value)
  check(parsed.success, `malformed result at '${path}'`)
  const result = parsed.data
  check(result.id === id, `malformed result at '${path}'`)
  check(
    resultId(updateOf(result)) === id && result.branch === result.intake.branch,
    `result identity mismatch at '${path}'`,
  )
  check(
    result.headSha === result.intake.headSha && resultRef(result) === result.ref,
    `result intake mismatch at '${path}'`,
  )
  return result
}

/**
 * The one ref a result's own contents could have come from.
 *
 * A branch push names its branch in the ref; a submit push names its base and
 * its change. Either way the ref is fully determined by fields the result
 * already carries, so this stays an equality — a result that cannot rebuild
 * its own ref is a result that has been edited.
 */
function resultRef(result: ReceiverResult): string {
  if (result.change === undefined) return `${BRANCH_PREFIX}${result.branch}`
  return `${SUBMIT_PREFIX}${result.intake.base}/${result.change}`
}

async function readResult(path: string, id: string): Promise<ReceiverResult> {
  try {
    return validateResult(JSON.parse(await readFile(path, "utf8")), id, path)
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw new Error(`yrd: receiver: invalid JSON in result '${path}': ${cause.message}`, { cause: cause })
    }
    throw cause
  }
}

async function moveResult(
  receiver: GitPushReceiver,
  result: ReceiverResult,
  from: ResultState,
  to: ResultState,
): Promise<void> {
  await linkResult(resultPath(receiver, from, result.id), resultPath(receiver, to, result.id), result)
  await rm(resultPath(receiver, from, result.id), { force: true })
  await syncDir(receiver.inboxDir)
}

async function validateStored(
  receiver: GitPushReceiver,
  result: ReceiverResult,
  options: ReceiverHookOptions,
): Promise<void> {
  validSha(result.oldSha, receiver.shaLength, "result old commit id", true)
  validSha(result.headSha, receiver.shaLength, "result head commit id")
  const update = updateOf(result)
  // The recheck must ask the SAME question the push asked. By now the bay a
  // submit opened exists, so a branch lookup would also answer — but only by
  // accident, and a resolver that answers only the intent would start failing
  // here for reasons that have nothing to do with authorization.
  const intent = result.change === undefined ? undefined : { base: result.intake.base, name: result.change }
  const resolved = await options.resolveTarget(result.branch, update, intent)
  check(resolved, withIntakePolicy(`branch '${result.branch}' is no longer authorized for Yrd intake`, options))
  const target = normalizeTarget(resolved, receiver)
  const stored = result.intake
  // Every field the result carries forward into intake is compared, including
  // the carrier branch: a submit resolver derives that branch rather than
  // reading it off the ref, so it is exactly the field that can move between
  // the push and the drain, and an unchecked field is an unauthorized one.
  check(
    stored.bay === target.bay &&
      stored.name === target.name &&
      stored.issue === target.issue &&
      stored.base === target.base &&
      stored.baseSha === target.baseSha &&
      stored.branch === (target.branch ?? result.branch),
    `authorization changed for result '${result.id}'`,
  )
  await validBranch(receiver, result.branch, "intake branch")
  await validBranch(receiver, result.intake.base, "base branch")
  await validatePin(receiver, update, target, options.env)
}

async function resultFiles(receiver: GitPushReceiver, state: ResultState): Promise<string[]> {
  const suffix = `.${state}.json`
  return (await readdir(receiver.inboxDir))
    .filter((name) => name.endsWith(suffix))
    .toSorted()
    .map((name) => join(receiver.inboxDir, name))
}

async function refContains(receiver: GitPushReceiver, ref: string, commit: string): Promise<boolean> {
  const current = await refValue(receiver, ref)
  if (current === null) return false
  if (current === commit) return true
  if (
    (await receiverGit(receiver, ["merge-base", "--is-ancestor", commit, current], { allowFailure: true })).code === 0
  ) {
    return true
  }
  const reflog = await receiverGit(receiver, ["reflog", "show", "--format=%H", ref], { allowFailure: true })
  return reflog.code === 0 && reflog.stdout.split("\n").includes(commit)
}

async function recoverPrepared(
  receiver: GitPushReceiver,
  options: ReceiverHookOptions,
  drain: ReceiverDrainResult,
): Promise<void> {
  for (const path of await resultFiles(receiver, "prepared")) {
    const id = basename(path).slice(0, -".prepared.json".length)
    try {
      const result = await readResult(path, id)
      if (!(await refContains(receiver, result.ref, result.headSha))) {
        drain.ambiguous.push(id)
        continue
      }
      await validateStored(receiver, result, options)
      await moveResult(receiver, result, "prepared", "pending")
    } catch (cause) {
      drain.failed.push({ id, error: message(cause) })
    }
  }
}

function resultOrder(left: StoredResult, right: StoredResult): number {
  return left.result.receivedAt.localeCompare(right.result.receivedAt) || left.result.id.localeCompare(right.result.id)
}

function orderBranch(results: StoredResult[]): StoredResult[] {
  const remaining = [...results].toSorted(resultOrder)
  const heads = new Set(results.map((item) => item.result.headSha))
  const ordered: StoredResult[] = []
  while (remaining.length > 0) {
    const root = remaining.findIndex((item) => !heads.has(item.result.oldSha))
    const [next] = remaining.splice(root < 0 ? 0 : root, 1)
    if (next === undefined) break
    ordered.push(next)
    heads.delete(next.result.headSha)
  }
  return ordered
}

async function pendingResults(receiver: GitPushReceiver, drain: ReceiverDrainResult): Promise<StoredResult[]> {
  const branches = new Map<string, StoredResult[]>()
  for (const path of await resultFiles(receiver, "pending")) {
    const id = basename(path).slice(0, -".pending.json".length)
    try {
      const result = await readResult(path, id)
      branches.set(result.branch, [...(branches.get(result.branch) ?? []), { path, result }])
    } catch (cause) {
      drain.failed.push({ id, error: message(cause) })
    }
  }
  return [...branches.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([, items]) => orderBranch(items))
}
