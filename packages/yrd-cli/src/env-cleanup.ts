import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import { atomicWriteFileSync } from "@bearly/durable-file"
import {
  createEventStore,
  gitIn,
  isAncestor,
  readBranchHistory,
  readRemoteCommit,
  refAt,
  registeredWorktrees,
  remoteUrl,
  selectionFor,
  type Git,
  type GitRunner,
  type GitSelection,
  type QueueConfig,
  type QueueRunOutcome,
} from "@yrd/queue-core"
import { createLocalGitProcess } from "git-super/process"
import {
  assertNoPrivateStore,
  createLocalGitWorktreeStore,
  PrivateStoreRefusalError,
  type ComponentCustodyFreshness,
} from "git-super/worktree"
import { inspectProcessCwds, resolveContainedPath, type ProcessCwdProjection } from "removely"
import { environmentCwdHolder, processCwdCoverage, validateLiveEnvironmentUses } from "./env-close-holders.ts"
import {
  IncompleteCensusError,
  PrivateCheckoutRefusalError,
  closeEnvironment,
  environmentInventory,
  privateStoreVerifyCommand,
} from "./env-commands.ts"
import {
  CloseRequestAlreadyStandsError,
  ENV_CLOSE_PREDICATE,
  MAX_COVERAGE_ATTEMPTS,
  closeRequestFile,
  dropCloseRequest,
  envRequestFile,
  listCloseRequests,
  listStagedCloseRequests,
  readCloseRequest,
  requesterOf,
  restoreCloseRequest,
  stageCloseRequest,
  unstageCloseRequest,
  writeCloseRequest,
  type EnvCloseRequest,
  type StoredEnvRequest,
  type StoredReleaseRequest,
} from "./env-close-requests.ts"
import { environmentProvenance } from "./env-cleanup-provenance.ts"
import {
  mergedCloseKeepReason,
  readEnvOpenRecord,
  throwIfStandingLifetime,
  type EnvOpenRecordRead,
} from "./env-open-record.ts"
import { repositoryHere } from "./declaration.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"
import type { WorktreeRemovalProof } from "./branch-retirement.ts"

type CachedEnvironment = {
  paths: { path: string; optional: boolean }[]
  branches: readonly string[]
  bindingKey?: string
  expensiveKey?: string
  verdict?: string
  retryRemoteProof?: boolean
  hold?: string | null
  busy?: string
}

/**
 * A round charged the spawn-producing evaluation of at most this many
 * environments, so the first pass over the fleet's whole registry is sliced
 * across rounds instead of exceeding the 27723 cost bar (30 s, 400 spawns) in
 * one of them: the registry holds hundreds of rows, and each costs several Git
 * calls. `cursor` is where the next round resumes,
 * so progress is guaranteed even when a row keeps failing its cheap checks.
 *
 * Measured 2026-10-06 against the delivered fleet registry: a 16-row round took
 * 28.8 s and 29.4 s (two in a row), because the issue-status lookup costs ~2 s
 * per distinct issue — too close to the 30 s bar to be safe. At 8 rows the same
 * work is ~14 s, and the git spawns stay far below 400 (an instrumented read of
 * this path measured 4 per row).
 */
const SWEEP_INSPECTION_BATCH = 8
// Each route yields after one locked close, including a kept result or a throw.
const CLOSE_ATTEMPTS_PER_ROUTE = 1
// A delegated release unblocks a seat now; it has its own budget, ahead of the close backlog (29772).
const RELEASE_ATTEMPTS_PER_ROUND = 1

/** One row of a release receipt, as `releaseRetainedCheckouts` reports it. */
type ReleaseRoundRow = Readonly<{ repo: string; branch: string; reason: string; detail?: string }>

/**
 * The round's own run of a delegated `drop --release-checkout` (29772): the same release, `--apply`, under the
 * same admission, from the context whose census reads every same-UID pid. The queue command supplies it.
 */
export type ReleaseCheckoutRound = (request: StoredReleaseRequest) => Promise<
  Readonly<{
    removed: readonly ReleaseRoundRow[]
    alreadyRetired: readonly ReleaseRoundRow[]
    kept: readonly ReleaseRoundRow[]
    failed: readonly ReleaseRoundRow[]
    needsDelegation: readonly ReleaseRoundRow[]
  }>
>
// Covers opening through the first commit, including time waiting for review.
const FRESH_ENVIRONMENT_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Resume state for the sweep. The cursor is a HINT read from the run's own
 * state dir, never authority: every row is re-evaluated by the rule, so a
 * missing, unreadable or stale hint costs time and nothing else (ruling 27723
 * durable cursor, 2026-10-06). Without it, a landing that moves vendor/yrd
 * restarts the service and restarts the sweep, so under landing churn the tail
 * of the registry — the backlog this change exists to retire — starves.
 */
export type PersistedCustodyRefusal = Readonly<{
  head: string
  branch?: string
  targetBranch: string
  endingEvent?: string
  component?: string
  fingerprint: string
  why: string
  recordedAt: string
}>

type CleanupProgress = {
  cursor: number
  hint: string | undefined
  loaded: boolean
  /**
   * The last row written per path, as `result\u0000why`, so a kept folder is written once per CHANGE of
   * reason rather than once per round (log-retention ruling 2026-10-16, "Not archival": ~50 unchanged keeps
   * reprinted every 2 minutes is writer volume, not signal). It is PERSISTED beside the resume cursor, in the
   * hint file this sweep already writes (extended, never a new state kind — @chief accepted the judgement call
   * 2026-10-16), so a restart, or a landing that advances the vendor/yrd pin, does not reprint the registry
   * either. It is bounded to the registry the round walked, so a retired environment leaves no entry behind.
   */
  reported: Map<string, string>
  /**
   * Completed `status: "blocked"` component-custody refusals keyed by environment path (#31206, @cto 83464c62).
   * Suppression-only: a matching freshness fingerprint avoids redundant startup refiling; any mismatch, missing
   * proof, or `status: "unknown"` falls through to the full removal proof. Bounded to live `inventory.rows`.
   */
  custodyRefusals: Map<string, PersistedCustodyRefusal>
}

/** Where the hint lives: the run's existing state dir, not a new config key. */
function cursorHintPath(workdir: string): string {
  return join(workdir, "state", "yrd", "environment-cleanup.json")
}

/**
 * The last-row map as the sweep's own state file carries it. An absent field is
 * the shape of a file written before the map existed — nothing reported, which
 * reprints once and is not a fault. Any other shape is uncertainty about the
 * document and throws, so the caller names the file and its reason exactly as it
 * does for a malformed cursor: guessing here would hide the next suppression.
 */
function reportedFromState(parsed: unknown): Map<string, string> {
  const field = (parsed as { reported?: unknown }).reported
  if (field === undefined) return new Map()
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    throw new Error("reported state is not a map of environment path to last row")
  }
  const reported = new Map<string, string>()
  for (const [path, key] of Object.entries(field)) {
    if (typeof key !== "string") {
      throw new Error(`reported state for ${JSON.stringify(path)} is not a last-row key`)
    }
    reported.set(path, key)
  }
  return reported
}

function custodyRefusalsFromState(parsed: unknown): Map<string, PersistedCustodyRefusal> {
  const field = (parsed as { custodyRefusals?: unknown }).custodyRefusals
  if (field === undefined) return new Map()
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    throw new Error("custodyRefusals state is not a map of environment path to refusal record")
  }
  const refusals = new Map<string, PersistedCustodyRefusal>()
  for (const [path, value] of Object.entries(field)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`custodyRefusals state for ${JSON.stringify(path)} is not an object`)
    }
    const record = value as Record<string, unknown>
    if (
      typeof record.head !== "string" ||
      !/^[0-9a-f]{40}$/u.test(record.head) ||
      (record.branch !== undefined && typeof record.branch !== "string") ||
      typeof record.targetBranch !== "string" ||
      record.targetBranch.trim() === "" ||
      (record.endingEvent !== undefined && typeof record.endingEvent !== "string") ||
      (record.component !== undefined && (typeof record.component !== "string" || record.component.trim() === "")) ||
      typeof record.fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(record.fingerprint) ||
      typeof record.why !== "string" ||
      typeof record.recordedAt !== "string"
    ) {
      throw new Error(`custodyRefusals state for ${JSON.stringify(path)} has an invalid shape`)
    }
    refusals.set(path, {
      head: record.head,
      ...(record.branch === undefined ? {} : { branch: record.branch }),
      targetBranch: record.targetBranch,
      ...(record.endingEvent === undefined ? {} : { endingEvent: record.endingEvent }),
      ...(record.component === undefined ? {} : { component: record.component }),
      fingerprint: record.fingerprint,
      why: record.why,
      recordedAt: record.recordedAt,
    })
  }
  return refusals
}

function extractComponentCustody(parsed: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof parsed === "object" &&
    parsed !== null &&
    "reason" in parsed &&
    parsed.reason === "component-custody" &&
    "custody" in parsed &&
    typeof parsed.custody === "object" &&
    parsed.custody !== null
    ? (parsed.custody as Readonly<Record<string, unknown>>)
    : undefined
}

function blockedCustodyRefusalRecord(
  custody: Readonly<Record<string, unknown>> | undefined,
  input: Readonly<{
    head: string
    branch?: string
    targetBranch: string
    endingEvent?: string
    why: string
  }>,
): PersistedCustodyRefusal | undefined {
  if (
    custody === undefined ||
    custody.status !== "blocked" ||
    typeof custody.component !== "string" ||
    custody.component.trim() === "" ||
    typeof custody.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(custody.fingerprint)
  ) {
    return undefined
  }
  return {
    head: input.head,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    targetBranch: input.targetBranch,
    ...(input.endingEvent === undefined ? {} : { endingEvent: input.endingEvent }),
    component: custody.component,
    fingerprint: custody.fingerprint,
    why: input.why,
    recordedAt: new Date().toISOString(),
  }
}

/**
 * Consume the durable close requests a caller filed because its own same-UID CWD
 * census could not certify the close (22894). This round IS the capable context:
 * it runs the SAME `closeEnvironment` lifecycle the direct verb runs, under the
 * direct admission predicate (clean, unlocked, no holder, ancestry not required),
 * up to CLOSE_ATTEMPTS_PER_ROUTE locked close attempts per invocation.
 *
 * Retirement is loud and bounded. Existence is checked FIRST, so a path already
 * gone is an `already-removed` row and never a close attempt (23162: freshness at
 * destruction). The registry row is re-read, and a gone registration, a hold or a
 * moved HEAD retires the request as `stale`; stale and gone rows do not count as
 * an attempt. Only an incomplete census is
 * retryable — at most MAX_COVERAGE_ATTEMPTS rounds — after which the file is
 * DELETED with the whole request and the last refusal in its final journal row
 * (no archive directory). Every other refusal retires at once with its reason.
 */
async function consumeCloseRequests(
  input: Readonly<{
    workdir: string
    registry: string
    primaryRoot: string
    targetBranch: string
    custodyRefusals: Map<string, PersistedCustodyRefusal>
    worktrees: Git
    io: YrdCliIO
    outcome: Pick<QueueRunOutcome, "run" | "log">
    onEnvironmentClosed?: (closed: ClosedEnvironment) => Promise<void>
    releaseCheckout?: ReleaseCheckoutRound
    readTip: (repository: string, branch: string) => Promise<string | undefined>
  }>,
): Promise<
  Readonly<{ attempted: number; closed: number; handled: ReadonlySet<string>; proofs: readonly WorktreeRemovalProof[] }>
> {
  const proofs: WorktreeRemovalProof[] = []
  const { workdir, registry, worktrees, io, outcome } = input
  const journal = (
    file: string,
    request: StoredEnvRequest | undefined,
    path: string,
    result: string,
    why: string,
    fingerprint?: string,
    timing?: Readonly<{ started_at: string; elapsed_ms: number }>,
  ): void => {
    const diagnostic =
      result === "retired"
        ? `${request?.intent === "release-checkout" ? "release" : "close"} not performed: ${why}`
        : why
    appendFileSync(
      outcome.log,
      `${JSON.stringify({
        kind: "observation",
        run: outcome.run,
        at: new Date().toISOString(),
        scope: "environment-cleanup",
        registry,
        path,
        ...(request === undefined
          ? { requestFile: file }
          : request.intent === "release-checkout"
            ? {
                request: {
                  intent: request.intent,
                  requester: request.requester,
                  at: request.at,
                  path: request.path,
                  release: request.release,
                  ...(request.coverageAttempts === undefined ? {} : { coverageAttempts: request.coverageAttempts }),
                },
              }
            : {
                request: {
                  intent: request.intent,
                  requester: request.requester,
                  at: request.at,
                  options: request.options,
                  path: request.path,
                  head: request.head,
                  ...(request.ending === undefined ? {} : { ending: request.ending }),
                  ...(fingerprint === undefined ? {} : { fingerprint }),
                  ...(request.coverageAttempts === undefined ? {} : { coverageAttempts: request.coverageAttempts }),
                },
              }),
        result,
        why: diagnostic,
        ...timing,
      })}\n`,
    )
    io.stderr(`yrd: environment close request ${file}: ${result}: ${diagnostic}\n`)
  }
  // Staging exists so a crash mid-close leaves the row in a named place. That
  // place needs a reader, or the request is orphaned and unjournaled forever:
  // name every staged row, then put it back (its slot free) so this round
  // re-evaluates it existence-first, or drop it when a re-request stands.
  for (const staged of listStagedCloseRequests(workdir)) {
    let interrupted: StoredEnvRequest | undefined
    try {
      interrupted = readCloseRequest(staged)
    } catch (cause) {
      journal(staged, undefined, staged, "unreadable", String(cause))
      continue
    }
    if (interrupted === undefined) continue
    const slot = envRequestFile(workdir, interrupted)
    if (!unstageCloseRequest(staged, slot)) {
      journal(
        slot,
        interrupted,
        interrupted.path,
        "interrupted-superseded",
        `${staged} was left by a round that died mid-close; a re-request already stands at ${slot}`,
      )
      dropCloseRequest(staged)
      continue
    }
    journal(
      slot,
      interrupted,
      interrupted.path,
      "interrupted",
      `${staged} was left by a round that died mid-close; re-evaluated this round`,
    )
  }
  // Read cheap intent metadata before choosing the oldest batch; filenames do not encode request age.
  // CLOSE_ATTEMPTS_PER_ROUTE bounds locked closes. Unreadable files are named and left standing without a slot.
  const readable: Array<{ file: string; request: StoredEnvRequest }> = []
  for (const file of listCloseRequests(workdir)) {
    try {
      const standing = readCloseRequest(file)
      if (standing === undefined) continue
      readable.push({ file, request: standing })
    } catch (cause) {
      // A file this round cannot read is named and LEFT STANDING: deleting it
      // would destroy the only record of who asked for what.
      journal(file, undefined, file, "unreadable", String(cause))
    }
  }
  if (readable.length === 0) return { attempted: 0, closed: 0, handled: new Set(), proofs }
  readable.sort((a, b) => {
    // A seat's own request (no `ending`) goes before the round's automatic filings for ended environments, so a
    // seat waits only behind other seats (31447, @cto 212b4ba9). Writers use UTC ISO times; retries retain the
    // original intent time.
    // A release request is always a seat's own; only a close carries `ending`.
    const automatic = (request: StoredEnvRequest) => request.intent === "close" && request.ending !== undefined
    const seat = Number(automatic(a.request)) - Number(automatic(b.request))
    const age = a.request.at === b.request.at ? 0 : a.request.at < b.request.at ? -1 : 1
    return seat || age || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  })
  const releases = readable.flatMap(({ file, request }) =>
    request.intent === "release-checkout" ? [{ file, request }] : [],
  )
  const closes = readable.flatMap(({ file, request }) => (request.intent === "close" ? [{ file, request }] : []))
  // 29772 (@cto c8d7113d): releases go first, on their own budget. The tip is read before any census: a moved
  // or gone branch retires the request as stale-reference, an unreadable one as unreadable, and neither is a
  // coverage attempt; a held release
  // (readable holder, live use, a refused protection) retires at once with its reason; only an incomplete
  // census retries, up to MAX_COVERAGE_ATTEMPTS rounds.
  let releaseAttempted = 0
  for (const { file, request } of releases) {
    if (releaseAttempted >= RELEASE_ATTEMPTS_PER_ROUND) break
    const { branch, tip } = request.release
    if (input.releaseCheckout === undefined) {
      journal(
        file,
        request,
        request.path,
        "kept",
        `this round has no release reader; ${releases.length} release request(s) left standing for a round that has one`,
      )
      break
    }
    let current: string | undefined
    try {
      current = await input.readTip(request.path, branch)
    } catch (cause) {
      // A tip the round cannot read is not a moved branch (@cto 585d1eac): its own class, cause named.
      journal(
        file,
        request,
        request.path,
        "unreadable",
        `refs/heads/${branch} in ${request.path} cannot be read: ${String(cause)}; nothing applied, the branch and its checkout kept`,
      )
      dropCloseRequest(file)
      continue
    }
    if (current !== tip) {
      journal(
        file,
        request,
        request.path,
        "stale-reference",
        `refs/heads/${branch} is ${current ?? "absent"}, not the requested tip ${tip}; nothing applied`,
      )
      dropCloseRequest(file)
      continue
    }
    releaseAttempted++
    const staged = stageCloseRequest(file)
    const startedAt = Date.now()
    const timing = { started_at: new Date(startedAt).toISOString(), elapsed_ms: 0 }
    const rows = (list: readonly ReleaseRoundRow[]): string =>
      list
        .map((row) => `${row.repo} ${row.branch}: ${row.reason}${row.detail === undefined ? "" : ` (${row.detail})`}`)
        .join("; ")
    let report: Awaited<ReturnType<ReleaseCheckoutRound>>
    try {
      report = await input.releaseCheckout(request).finally(() => {
        timing.elapsed_ms = Date.now() - startedAt
      })
    } catch (cause) {
      journal(file, request, request.path, "retired", `${String(cause)}; branch and checkout kept`, undefined, timing)
      dropCloseRequest(staged)
      continue
    }
    if (
      report.failed.length === 0 &&
      report.needsDelegation.length > 0 &&
      report.kept.length === report.needsDelegation.length
    ) {
      const attempts = (request.coverageAttempts ?? 0) + 1
      const retried = { ...request, coverageAttempts: attempts }
      if (attempts >= MAX_COVERAGE_ATTEMPTS) {
        journal(
          file,
          retried,
          request.path,
          "retired",
          `coverage refused ${attempts} times; last: ${rows(report.needsDelegation)}`,
          undefined,
          timing,
        )
        dropCloseRequest(staged)
      } else {
        journal(
          file,
          retried,
          request.path,
          "kept",
          `coverage refused ${attempts} of ${MAX_COVERAGE_ATTEMPTS}; retried next round: ${rows(report.needsDelegation)}`,
          undefined,
          timing,
        )
        restoreCloseRequest(staged, file, attempts)
      }
      continue
    }
    if (report.failed.length > 0 || report.kept.length > 0) {
      journal(
        file,
        request,
        request.path,
        "retired",
        `held: ${rows([...report.failed, ...report.kept])}; branch kept`,
        undefined,
        timing,
      )
      dropCloseRequest(staged)
      continue
    }
    journal(
      file,
      request,
      request.path,
      "released",
      `${rows([...report.removed, ...report.alreadyRetired])}; checkout bytes kept`,
      undefined,
      timing,
    )
    dropCloseRequest(staged)
  }
  if (closes.length === 0) return { attempted: 0, closed: 0, handled: new Set(), proofs }
  let inventory = await environmentInventory(registry, worktrees, workdir)
  let inventoryStale = false
  let attempted = 0
  let closed = 0
  const handled = new Set<string>()
  for (const { file, request } of closes) {
    // Cheap dispositions: missing path, absent registration, held registration, or changed HEAD.
    // After admission fills, use the captured inventory; refreshing it would spawn Git for a deferred row.
    handled.add(request.path)
    if (!existsSync(request.path)) {
      input.custodyRefusals.delete(request.path)
      journal(file, request, request.path, "already-removed", `${request.path} is gone; the request is satisfied`)
      dropCloseRequest(file)
      continue
    }
    if (inventoryStale && attempted < CLOSE_ATTEMPTS_PER_ROUTE) {
      inventory = await environmentInventory(registry, worktrees, workdir)
      inventoryStale = false
    }
    const current = inventory.rows.find((row) => row.path === request.path)
    if (current === undefined) {
      input.custodyRefusals.delete(request.path)
      journal(file, request, request.path, "stale", `${request.path} is no longer a registered environment`)
      dropCloseRequest(file)
      continue
    }
    const fingerprint =
      `${current.name} ${current.branch ?? "(detached)"} ${current.head ?? "(no head)"} ` +
      `hold=${current.hold === null ? "no" : JSON.stringify(current.hold)}`
    if (current.hold !== null) {
      input.custodyRefusals.delete(request.path)
      journal(
        file,
        request,
        request.path,
        "stale",
        `held${current.hold === "" ? "" : `: ${current.hold}`}`,
        fingerprint,
      )
      dropCloseRequest(file)
      continue
    }
    if (current.head !== request.head) {
      input.custodyRefusals.delete(request.path)
      journal(
        file,
        request,
        request.path,
        "stale",
        `registered HEAD moved from ${request.head} to ${current.head ?? "(none)"}`,
        fingerprint,
      )
      dropCloseRequest(file)
      continue
    }
    if (attempted >= CLOSE_ATTEMPTS_PER_ROUTE) {
      handled.delete(request.path)
      journal(file, request, request.path, "deferred", "cap")
      continue
    }
    // Stage before the close so two consumers cannot both act on one request and
    // a crash mid-close leaves the row in a named place.
    attempted++
    inventoryStale = true
    const staged = stageCloseRequest(file)
    const ending = request.ending
    let exit: YrdCliExitCode
    let output = ""
    let closedProof: WorktreeRemovalProof | undefined
    const closeStartedAt = Date.now()
    const timing = { started_at: new Date(closeStartedAt).toISOString(), elapsed_ms: 0 }
    try {
      exit = await closeEnvironment(
        request.path,
        {
          ...request.options,
          json: true,
          ...(ending === undefined
            ? {}
            : { componentCustody: { primaryRoot: input.primaryRoot, targetBranch: ending.queue } }),
        },
        {
          ...io,
          cwd: registry,
          stdout: (text) => {
            output += text
          },
        },
        undefined,
        // The round IS the capable context: an incomplete census here must
        // never file a second request (that is a close nobody asked for).
        "refuse",
        ending === undefined
          ? undefined
          : async () => {
              const store = createEventStore(registry, ending.remote, selectionFor(worktrees))
              const current = (await readBranchHistory(store, ending.queue, ending.branch)).history?.state
              if (
                current?.tip !== ending.event ||
                current.commit !== request.head ||
                (current.status !== "merged" && !(current.status === "cancelled" && current.reason === "withdrawn"))
              ) {
                throw new Error(
                  `${request.path}: automatic close expected ${ending.remote}#${ending.queue} ${ending.branch}@${ending.event}/${request.head}; read ${current?.status ?? "no history"}@${current?.tip ?? "no event"}/${current?.commit ?? "no submitted head"}; environment kept`,
                )
              }
              const registration = (await registeredWorktrees(worktrees)).find(
                (row) => resolve(row.path) === request.path,
              )
              if (registration?.branch !== ending.branch || registration.head !== request.head) {
                throw new Error(
                  `${request.path}: native worktree registry expected ${ending.branch}@${request.head}; read ${registration?.branch ?? "no registration"}@${registration?.head ?? "no HEAD"}; environment kept`,
                )
              }
            },
        (proof) => {
          closedProof = proof
          proofs.push(proof)
        },
      ).finally(() => {
        timing.elapsed_ms = Date.now() - closeStartedAt
      })
    } catch (cause) {
      if (cause instanceof IncompleteCensusError) {
        const attempts = (request.coverageAttempts ?? 0) + 1
        const retired = { ...request, coverageAttempts: attempts }
        if (attempts >= MAX_COVERAGE_ATTEMPTS) {
          journal(
            file,
            retired,
            request.path,
            "retired",
            `coverage refused ${attempts} times; last: ${cause.refusal}`,
            fingerprint,
            timing,
          )
          dropCloseRequest(staged)
        } else {
          journal(
            file,
            retired,
            request.path,
            "kept",
            `coverage refused ${attempts} of ${MAX_COVERAGE_ATTEMPTS}; retried next round: ${cause.refusal}`,
            fingerprint,
            timing,
          )
          restoreCloseRequest(staged, file, attempts)
        }
        continue
      }
      // 28661 C4 / 27120 (@dev/review2 P2): a close refused to protect a declared-private submodule store is
      // not the queue's to fix — whether git-super's guard raised it or `env close` raised this CLI's own
      // private-checkout class. ONE predicate decides that, so a class the ordinary sweep row already knows
      // cannot be missed here. The tree stays, the round CONTINUES, and the request stays standing so the
      // operator's cure is done once and the next round closes it - bounded exactly like the coverage refusal,
      // so it is named and never nagged. Dropping it as "retired" would erase who asked for the close.
      if (privateRefusalIn(cause) !== undefined) {
        const attempts = (request.coverageAttempts ?? 0) + 1
        const refused = { ...request, coverageAttempts: attempts }
        // The CLASS and the real route, read from the refusal's own structured payload — never from prose.
        const named = namedPrivateStoreRefusal(cause, request.path) ?? String(cause)
        if (attempts >= MAX_COVERAGE_ATTEMPTS) {
          journal(
            file,
            refused,
            request.path,
            "retired",
            `a private submodule store refused the close ${attempts} times; last: ${named}`,
            fingerprint,
            timing,
          )
          dropCloseRequest(staged)
        } else {
          journal(
            file,
            refused,
            request.path,
            "kept",
            `a private submodule store refused the close ${attempts} of ${MAX_COVERAGE_ATTEMPTS}; retried next round: ${named}`,
            fingerprint,
            timing,
          )
          restoreCloseRequest(staged, file, attempts)
        }
        continue
      }
      journal(file, request, request.path, "retired", String(cause), fingerprint, timing)
      dropCloseRequest(staged)
      continue
    }
    const failed = failedRetirements(output, request.path)
    if (exit !== 0 && failed === undefined) {
      journal(
        file,
        request,
        request.path,
        "retired",
        `native close exited ${exit}: ${output.trim()}`,
        fingerprint,
        timing,
      )
      dropCloseRequest(staged)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(output)
    } catch {
      journal(file, request, request.path, "retired", `malformed close result ${output.trim()}`, fingerprint, timing)
      dropCloseRequest(staged)
      continue
    }
    if (typeof parsed === "object" && parsed !== null && "closed" in parsed && parsed.closed === request.path) {
      input.custodyRefusals.delete(request.path)
      journal(
        file,
        request,
        request.path,
        "closed",
        `closed at the request of ${request.requester}${failed === undefined ? "" : `; branch retirement failed: ${failed.join("; ")}`}`,
        fingerprint,
        timing,
      )
      dropCloseRequest(staged)
      closed++
      try {
        await input.onEnvironmentClosed?.({
          ...(ending === undefined ? {} : { branch: ending.branch }),
          head: request.head,
          path: request.path,
          ...(closedProof === undefined ? {} : { proof: closedProof }),
        })
      } catch (cause) {
        journal(
          file,
          request,
          request.path,
          "tell-failed",
          `closed, but telling about it failed: ${reasonText(cause)}`,
          fingerprint,
        )
      }
      continue
    }
    const custody = extractComponentCustody(parsed)
    const keptReason = `kept: ${output.trim()}`
    const custodyReason =
      custody === undefined
        ? undefined
        : `${keptReason}; environment remains registered; elapsed_ms=${timing.elapsed_ms}; ` +
          (custody.status === "blocked"
            ? `cure: land or push ${String(custody.component)}, then re-request`
            : "GitSuper custody proof budget or input could not be verified; inspect the reported proof failure before re-requesting")
    const retiredWhy =
      typeof parsed === "object" && parsed !== null && "kept" in parsed
        ? (custodyReason ?? keptReason)
        : `unproven close result ${output.trim()}`
    const blockedRefusal = blockedCustodyRefusalRecord(custody, {
      head: request.head,
      branch: ending?.branch ?? current.branch,
      targetBranch: ending?.queue ?? input.targetBranch,
      endingEvent: ending?.event,
      why: `close not performed: ${retiredWhy}`,
    })
    if (blockedRefusal !== undefined) {
      input.custodyRefusals.set(request.path, blockedRefusal)
    } else {
      input.custodyRefusals.delete(request.path)
    }
    journal(file, request, request.path, "retired", retiredWhy, fingerprint, timing)
    dropCloseRequest(staged)
  }
  return { attempted, closed, handled, proofs }
}

/**
 * CTO A / 21122 / 29367: merged and explicitly withdrawn exact jobs use the event filer. A bound environment whose
 * branch ended in this invocation gets the same durable close request the incomplete-
 * census path writes. Filing is intent, never a census fact. Held rows and
 * missing HEADs are named; a write this process cannot make is `file-failed`.
 * DROPPED / issue-ended do not file here; they widen the sweep.
 */
/** One named class from a refused `env close --json`, or undefined when that refusal names none. */
function closeResult(output: string): Readonly<Record<string, unknown>> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch (cause) {
    // A refusal's own text is not always JSON — a plain-`git` refusal, an older yrd, a person's `env close` —
    // and that is the ordinary "no structured refusal to read" case, so it returns undefined. Anything the
    // parser fails on for ANOTHER reason is a real fault, and a silent undefined would hide it behind a
    // "kept: (no class)" line instead of naming it (NO SILENT ERRORS).
    if (!(cause instanceof SyntaxError)) throw cause
    return undefined
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Readonly<Record<string, unknown>>) : undefined
}

/**
 * A close that removed its environment but failed a branch retirement exits 1 and still reports `closed`, with
 * each failure in `failed` (30642). The environment is gone, so the caller counts it closed and names the failures.
 */
function failedRetirements(output: string, path: string): readonly string[] | undefined {
  const row = closeResult(output)
  if (row?.closed !== path || !Array.isArray(row.failed) || row.failed.length === 0) return undefined
  return row.failed.map(String)
}

function namedCloseRefusal(output: string): string | undefined {
  const row = closeResult(output)
  if (row === undefined) return undefined
  if (typeof row.kept !== "string" || typeof row.class !== "string" || row.class === "") return undefined
  const parts = [`kept: ${row.class}`]
  if (typeof row.store === "string" && row.store !== "") parts.push(`store ${row.store}`)
  if (typeof row.command === "string" && row.command !== "") parts.push(`retire with ${row.command}`)
  return parts.join("; ")
}

/**
 * The typed private refusal at any depth of a cause chain — git-super's store refusal (the class queue-core's
 * `isPrivateStoreRefusal` walks this same way for) OR the CLI's own private-checkout refusal `env close` raises
 * from R1 — or undefined for any other cause. This is the ONE walk: the close-request disposition above and the
 * reason text below both read it, so a class cannot be recognized by the ordinary sweep row and missed by the
 * request path the way @dev/review2's exception-correction review found (#27120 P2). Never message prose.
 */
function privateRefusalIn(cause: unknown): PrivateStoreRefusalError | PrivateCheckoutRefusalError | undefined {
  for (let at: unknown = cause; at instanceof Error; at = at.cause) {
    if (at instanceof PrivateStoreRefusalError) return at
    if (at instanceof PrivateCheckoutRefusalError) return at
  }
  return undefined
}

/**
 * One cause as a REASON, never `Error: <message>`.
 *
 * The sweep uses `throw new Error(<keep reason>)` as control flow — `fresh: opened …`, `held`,
 * `opening lifetime standing`, `eligible; yielding to the next queue round` — and its catch records what it
 * caught. Stringifying the Error there printed `kept: Error: fresh: opened …`, so a benign keep read as a
 * failure (#29679 defect 1, round1-merge.log:112). The reason TEXT itself is unchanged; the Error wrapper is.
 */
function reasonText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The standing-request refusal at any depth of a cause chain, or undefined for any other cause. */
function closeRequestAlreadyStands(cause: unknown): CloseRequestAlreadyStandsError | undefined {
  for (let at: unknown = cause; at instanceof Error; at = at.cause) {
    if (at instanceof CloseRequestAlreadyStandsError) return at
  }
  return undefined
}

/**
 * One named class from a cause that IS a typed private refusal at any depth, or undefined for any other cause.
 * Read from the guard's own structured payload — never from message prose, and never a second `modules/<name>`
 * derivation — so the sweep reports `kept: private checkout; store <store>; retire with <command>` for the tree,
 * not a per-seat note (#27120 AC2). This is the boundary the refusal actually crosses: both the pre-close
 * inspection and the close THROW it, so the exit-code formatter below is never reached on a refusal.
 */
function namedPrivateStoreRefusal(cause: unknown, environment: string): string | undefined {
  const at = privateRefusalIn(cause)
  if (at instanceof PrivateCheckoutRefusalError) return namedPrivateCheckout(at.refusal.checkout, at.refusal.store)
  if (!(at instanceof PrivateStoreRefusalError)) return undefined
  return at.refusals.length === 0
    ? undefined
    : at.refusals.map((entry) => namedPrivateCheckout(join(environment, entry.path), entry.store)).join("; ")
}

/** The one line a private checkout is reported by: its class, the store, and the route that retires it. */
function namedPrivateCheckout(checkout: string, store: string | undefined): string {
  const parts = ["kept: private checkout"]
  if (store !== undefined) {
    parts.push(`store ${store}`)
    parts.push(`retire with ${privateStoreVerifyCommand(store, checkout)}`)
  }
  return parts.join("; ")
}

async function fileTerminalCloseRequests(
  input: Readonly<{
    workdir: string
    rows: readonly { path: string; branch?: string; head?: string; hold: string | null }[]
    terminal: readonly string[]
    branchRoots: readonly string[]
    selection: GitSelection
    env?: NodeJS.ProcessEnv
    custodyRefusals: Map<string, PersistedCustodyRefusal>
    suppressed: Set<string>
    inspectCustodyFreshness: (
      path: string,
      targetBranch: string,
      component: string,
    ) => Promise<ComponentCustodyFreshness>
    record: (path: string, result: string, why: string) => void
    preserve: (path: string, why: string) => void
    automaticKeep: (path: string, opening: EnvOpenRecordRead, terminal?: boolean) => string | undefined
    terminalHead: (
      branch: string,
    ) => Promise<Readonly<{ head: string; ending: NonNullable<EnvCloseRequest["ending"]> }>>
  }>,
): Promise<void> {
  if (input.terminal.length === 0) return
  const terminal = new Set(input.terminal)
  const uid = typeof globalThis.process.getuid === "function" ? globalThis.process.getuid() : -1
  const filedBy = requesterOf(input.env ?? globalThis.process.env)
  const requester = filedBy === "unknown" ? "yrd" : filedBy
  for (const row of input.rows) {
    if (row.branch === undefined || !terminal.has(row.branch)) continue
    if (row.hold !== null) continue
    if (row.head === undefined) {
      input.record(row.path, "file-failed", `terminal ${row.branch} but registered environment has no HEAD`)
      continue
    }
    try {
      const { head, ending } = await input.terminalHead(row.branch)
      if (row.head !== head) {
        input.custodyRefusals.delete(row.path)
        input.record(row.path, "kept", `terminal ${row.branch}@${head}; environment advanced to ${row.head}`)
        continue
      }
      const gitDir = (
        await gitIn(row.path, undefined, input.selection, { env: input.env })(["rev-parse", "--absolute-git-dir"])
      ).trim()
      const opening = readEnvOpenRecord(gitDir)
      const keep = input.automaticKeep(row.path, opening, true)
      if (keep !== undefined) {
        input.record(row.path, "kept", keep)
        continue
      }
      if (opening.status === "unrecorded") {
        // The general ancestry sweep owns unrecorded rows; recording a keep here clobbers its state.
        continue
      }
      const lifetimeKeep = mergedCloseKeepReason(opening)
      if (lifetimeKeep !== undefined) {
        input.record(row.path, "kept", lifetimeKeep)
        continue
      }
      // env open ties task/<name> to this path. A later checkout must not
      // turn a personal bay into the merged change's disposable environment.
      const openedForBranch = input.branchRoots.some(
        (root) =>
          row.branch ===
          `task/${relative(existsSync(root) ? realpathSync(root) : resolve(root), row.path)
            .split(sep)
            .join("/")}`,
      )
      if (!openedForBranch) {
        input.record(row.path, "kept", `terminal ${row.branch}; environment was not opened for that branch`)
        continue
      }
      const provenance = await environmentProvenance(
        row.path,
        gitIn(row.path, undefined, input.selection, { env: input.env }),
        row.branch,
      )
      if (provenance.branches.length !== 1 || provenance.branches[0] !== row.branch) {
        input.record(row.path, "kept", `terminal ${row.branch}; environment spans ${provenance.branches.join(", ")}`)
        continue
      }
      const prior = input.custodyRefusals.get(row.path)
      const requestSlot = closeRequestFile(input.workdir, row.path)
      const stagedSlot = join(dirname(requestSlot), ".processing", basename(requestSlot))
      if (prior !== undefined && existsSync(stagedSlot)) {
        // Leave the slot free so consumeCloseRequests unstages the interrupted .processing/ request and drains it.
        continue
      }
      if (prior !== undefined && !existsSync(requestSlot)) {
        if (
          prior.head !== row.head ||
          prior.branch !== row.branch ||
          prior.targetBranch !== ending.queue ||
          (prior.endingEvent !== undefined && prior.endingEvent !== ending.event) ||
          prior.component === undefined
        ) {
          input.custodyRefusals.delete(row.path)
        } else {
          const freshness = await input.inspectCustodyFreshness(row.path, ending.queue, prior.component)
          if (freshness.status === "ok" && freshness.fingerprint === prior.fingerprint) {
            input.suppressed.add(row.path)
            input.preserve(row.path, `unchanged since ${prior.recordedAt}: ${prior.why}`)
            continue
          }
          if (freshness.status === "ok") {
            input.custodyRefusals.delete(row.path)
          }
        }
      }
      const { file, alreadyStood } = writeCloseRequest(input.workdir, {
        name: basename(row.path),
        path: row.path,
        requester,
        uid,
        at: new Date().toISOString(),
        intent: "close",
        predicate: ENV_CLOSE_PREDICATE,
        options: { noRehome: true },
        head: row.head,
        ending,
      })
      input.record(
        row.path,
        "filed",
        `${alreadyStood ? "close request already stood" : "close request"} ${file} after terminal ending of ${row.branch}`,
      )
    } catch (cause) {
      // #29679 defect 2: a request that already STANDS is a no-op, not a failure — nothing was written and
      // nothing failed. It is reported as `filed`, naming the standing file, exactly like the same-options
      // path above; the standing request is never overwritten (hand-start-1827.log:38).
      const stood = closeRequestAlreadyStands(cause)
      if (stood !== undefined) {
        input.record(
          row.path,
          "filed",
          `close request already stood ${stood.file} from ${stood.standing.requester} with a different ending; ` +
            `left as it stands after terminal ending of ${row.branch}`,
        )
        continue
      }
      input.record(row.path, "file-failed", reasonText(cause))
    }
  }
}

/**
 * Automatic merged-close filing and the sweep share external live-use
 * protection (realpath equal to or inside the environment). Only the sweep
 * applies the 24-hour opening grace; an exact merged job can close immediately.
 * Read external uses once per round before filing; failure keeps automatic
 * candidates with a named reason. Explicit close intent keeps its own lifecycle.
 * Held/standing, busy, dirty and custody checks still protect terminal jobs;
 * the general sweep also requires exact-head ancestry on target.
 * Regressions in tests/queue-core-up.test.ts:
 * - a declared seat cwd survives cleanup without a process holder
 * - a newly opened environment survives cleanup inside the grace window and becomes eligible after it
 * The hh host integration covers its resolver in tools/yrd-runtime-json-output.slow.test.ts:
 * - a declared Hab slot preserves its environment through a round and a changed declaration releases it
 */
export function createEnvironmentCleanup() {
  const cache = new Map<string, CachedEnvironment>()
  const progress: CleanupProgress = {
    cursor: 0,
    hint: undefined,
    loaded: false,
    reported: new Map(),
    custodyRefusals: new Map(),
  }
  return (input: Parameters<typeof cleanupEnvironments>[0]) => cleanupEnvironments(input, cache, progress)
}

/** A missing required index/reflog is uncertainty, never an unchanged identity. */
function identity(file: Readonly<{ path: string; optional: boolean }>): string {
  try {
    const stat = statSync(file.path, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (file.optional && (code === "ENOENT" || code === "ENOTDIR")) return "absent optional path"
    throw new Error(`cannot inspect cleanup input ${file.path}: ${String(cause)}`, { cause })
  }
}

/** One completed round applies the same predicate to current and backlog environments. */
async function proveEnvironmentRemovable(input: {
  path: string
  head: string
  repo: string
  env: NodeJS.ProcessEnv | undefined
  target: string
  originBranch: string
  treeGit: ReturnType<typeof gitIn>
  entry: CachedEnvironment
  ancestor: (root: string, head: string, target: string) => Promise<void>
}): Promise<void> {
  input.entry.retryRemoteProof = false
  await input.ancestor(input.path, input.head, input.target)
  // A private store is reported by its own class and retire route (#27120 AC2). Removal inspection refuses an empty
  // checkout whose store survives as an unknown submodule state (#30563), so the private-store question goes first.
  const adminDir = (await input.treeGit.at(input.path)(["rev-parse", "--absolute-git-dir"])).trim()
  await assertNoPrivateStore(createLocalGitProcess(), { adminDir, repository: input.path, head: input.head })
  const inspection = await createLocalGitWorktreeStore({ repo: input.repo, env: input.env }).inspectRemoval(input.path)
  for (const component of inspection.consultedRepositories) {
    if (component.path === ".") continue
    for (const resource of ["index", `refs/remotes/origin/${input.originBranch}`, "packed-refs"]) {
      const path = (await input.treeGit.at(component.root)(["rev-parse", "--git-path", resource])).trim()
      if (path === "") throw new Error(`component ${component.root}: Git returned no ${resource} path`)
      const absolute = resolve(component.root, path)
      if (!input.entry.paths.some((file) => file.path === absolute)) {
        input.entry.paths.push({ path: absolute, optional: resource !== "index" })
      }
    }
  }
  for (const component of inspection.uninitializedSubmodules) {
    const path = join(input.path, component, ".git")
    if (!input.entry.paths.some((file) => file.path === path)) input.entry.paths.push({ path, optional: true })
  }
  if (inspection.records.length > 0) throw new Error(`dirty root/components: ${inspection.records.join("; ")}`)
  if (inspection.notCompared.length > 0) {
    throw new Error(`repository coverage unproven: ${JSON.stringify(inspection.notCompared)}`)
  }
  if (inspection.borrowers.length > 0) throw new Error(`borrowed by ${inspection.borrowers.join(", ")}`)
  for (const component of inspection.consultedRepositories) {
    if (component.path === ".") continue
    if (component.to === undefined) throw new Error(`materialized component ${component.root} has no HEAD`)
    const componentGit = input.treeGit.at(component.root)
    const localTarget = await refAt(componentGit, `refs/remotes/origin/${input.originBranch}`)
    if (localTarget !== undefined && (await isAncestor(componentGit, component.to, localTarget))) continue
    // A private tracking ref may lag publication. Remote-dependent keeps must
    // retry even when neither the root target nor local filesystem changes.
    input.entry.retryRemoteProof = true
    const remoteRef = `refs/heads/${input.originBranch}`
    try {
      const published = await readRemoteCommit(componentGit, "origin", remoteRef)
      if (published === undefined) throw new Error(`origin ${remoteRef} is absent`)
      await input.ancestor(component.root, component.to, published)
    } catch (cause) {
      throw new Error(`component ${component.root}: origin ${remoteRef} publication unproven: ${reasonText(cause)}`, {
        cause,
      })
    }
  }
  input.entry.retryRemoteProof = false
}

/**
 * One environment this cleanup actually closed, handed to the caller so the
 * author can be told (29720). `branch`/`head` are absent when the registry
 * could not name them; `proof` is the retained-removal proof the close
 * reported, absent when the close needed none.
 */
export type ClosedEnvironment = Readonly<{
  branch?: string
  head?: string
  path: string
  proof?: WorktreeRemovalProof
}>

async function cleanupEnvironments(
  input: Readonly<{
    repo: string
    git: GitRunner
    config: QueueConfig
    workdir: string
    outcome: Pick<QueueRunOutcome, "run" | "log" | "merged" | "target">
    withdrawn?: readonly string[]
    io: YrdCliIO
    env?: NodeJS.ProcessEnv
    selection: GitSelection
    /** Told about each environment this run closed; telling never gates the close. */
    onEnvironmentClosed?: (closed: ClosedEnvironment) => Promise<void>
    /** Runs a delegated `drop --release-checkout` in this round (29772); absent, release requests stay standing. */
    releaseCheckout?: ReleaseCheckoutRound
  }>,
  cache: Map<string, CachedEnvironment>,
  progress: CleanupProgress,
): Promise<readonly WorktreeRemovalProof[]> {
  const proofs: WorktreeRemovalProof[] = []
  const { repo, git, config, workdir, outcome, io } = input
  // The author environments live in the worktree registry of the repository
  // this command STANDS IN — the declaration's own repository — never the
  // queue-owned clone the round reads its authority from (27723 @cto ruling
  // 2026-10-06: `yrd env open` registers an author environment in the
  // repository it runs in, and the fleet's are registered in /hh/dev). The
  // service stands in its landing, whose common dir is /hh/dev/.git, so the
  // same registry is read without naming any path.
  const registry = repositoryHere(io.cwd) ?? repo
  const registryGit = registry === repo ? git : gitIn(registry, undefined, input.selection, { env: input.env })
  const inventory = await environmentInventory(registry, registryGit, workdir)
  if (inventory.rows.length === 0) {
    // An empty registry is a fact about WHERE the round looked, never a silent
    // no-op: name the repository whose registry was read and the roots excluded.
    appendFileSync(
      outcome.log,
      `${JSON.stringify({
        kind: "observation",
        run: outcome.run,
        at: new Date().toISOString(),
        scope: "environment-cleanup",
        registry,
        closed: 0,
        kept: 0,
        remaining: 0,
        deferred: 0,
        result: "none",
        why: `no registered environments under ${inventory.roots.join(" or ")}`,
      })}\n`,
    )
    return proofs
  }
  let closed = 0
  let kept = 0
  const record = (
    path: string,
    result: string,
    why: string,
    timing?: Readonly<{ started_at: string; elapsed_ms: number }>,
  ): void => {
    // A kept folder is written once per CHANGE of reason, never once per round (#29679 row 5, log-retention
    // ruling "Not archival"): a live registry reprinted ~50 unchanged keeps every 2 minutes, which is writer
    // volume and buries the rows that moved. The count still advances (`preserve`'s kept++), so the round's
    // footer keeps reporting the coverage it walked; only the unchanged row is withheld. Every other result
    // is an event and is always written.
    const key = `${result}\u0000${why}`
    const unchanged = result === "kept" && progress.reported.get(path) === key
    progress.reported.set(path, key)
    if (unchanged) return
    const row = {
      kind: "observation",
      run: outcome.run,
      at: new Date().toISOString(),
      scope: "environment-cleanup",
      registry,
      path,
      result,
      why,
      ...timing,
    }
    appendFileSync(outcome.log, `${JSON.stringify(row)}\n`)
    io.stderr(`yrd: environment ${path}: ${result}: ${why}\n`)
  }
  const preserve = (path: string, why: string, timing?: Readonly<{ started_at: string; elapsed_ms: number }>): void => {
    kept++
    record(path, "kept", why, timing)
  }
  /** The service's own coverage receipt; the CWD ruling requires rows, unreadable and uncleared from this process. */
  let censusReceipt:
    | Readonly<{ mechanism: string; complete: boolean; rows: number; unreadable: number; uncleared: number }>
    | undefined
  const census = async (): Promise<ProcessCwdProjection> => {
    const snapshot = await inspectProcessCwds({ deadlineMs: 2_000 })
    // A denied same-UID read is cleared only by removely's own identity
    // predicate. Anything it cannot clear could be a holder, so the run keeps
    // the environment and names the pid, command and denial it could not rule out.
    const coverage = processCwdCoverage(snapshot)
    censusReceipt = {
      mechanism: snapshot.mechanism,
      complete: snapshot.complete,
      rows: snapshot.rows.length,
      unreadable: snapshot.unreadable.length,
      uncleared: coverage.uncleared.length,
    }
    if (coverage.refusal !== undefined) throw new Error(coverage.refusal)
    return snapshot
  }
  const busy = (path: string, snapshot: ProcessCwdProjection): string | undefined => {
    const holder = environmentCwdHolder(path, snapshot)
    return holder === undefined ? undefined : `process ${holder.pid} has CWD ${holder.cwd}`
  }
  const process = createLocalGitProcess()
  const ancestor = async (root: string, head: string, target: string): Promise<void> => {
    const result = await process.run({
      repo: root,
      args: ["merge-base", "--is-ancestor", head, target],
      env: input.env,
      timeoutMs: 10_000,
    })
    if (
      result.failure !== undefined ||
      result.signal ||
      result.timedOut ||
      result.stalled ||
      result.backstop !== undefined ||
      (result.code !== 0 && result.code !== 1)
    ) {
      throw new Error(`ancestry ${head} -> ${target} in ${root} failed: ${JSON.stringify(result)}`)
    }
    if (result.code === 1) throw new Error(`commit ${head} in ${root} is not on target ${target}`)
  }
  let liveUses: readonly Readonly<{ path: string; reason: string }>[] = []
  let liveUseFailure: string | undefined
  if (io.liveEnvironmentUse !== undefined) {
    try {
      liveUses = validateLiveEnvironmentUses(await io.liveEnvironmentUse()).map((use) => ({
        path: resolveContainedPath(use.path, parse(use.path).root, { allowRoot: true }),
        reason: use.reason,
      }))
    } catch (cause) {
      liveUseFailure = `live environment-use reader unavailable: ${String(cause)}`
    }
  }
  const automaticKeep = (path: string, opening: EnvOpenRecordRead, terminal = false): string | undefined => {
    if (liveUseFailure !== undefined) return liveUseFailure
    if (liveUses.length > 0) {
      const environment = realpathSync(path)
      const use = liveUses.find((candidate) => {
        const inside = relative(environment, candidate.path)
        return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
      })
      if (use !== undefined) return `live use: ${use.reason} (${use.path})`
    }
    // An exact terminal job can close immediately; an unfinished opening keeps its grace.
    if (!terminal && opening.status === "recorded") {
      const openedAt = Date.parse(opening.record.at)
      if (!Number.isFinite(openedAt)) return `opening timestamp unproven: ${JSON.stringify(opening.record.at)}`
      if (Date.now() - openedAt < FRESH_ENVIRONMENT_GRACE_MS) return `fresh: opened ${opening.record.at}`
    }
    return undefined
  }
  const store = { repo, remote: config.target.remote, selection: git.selection, backend: git.backend }
  const historyCache = new Map<string, ReturnType<typeof readBranchHistory>>()
  const historyOf = (branch: string): ReturnType<typeof readBranchHistory> => {
    const cached = historyCache.get(branch)
    if (cached !== undefined) return cached
    const pending = readBranchHistory(store, config.target.branch, branch)
    historyCache.set(branch, pending)
    return pending
  }
  // File before census so a round that cannot certify still leaves the request
  // for the next consume.
  // The sweep's own state — the resume cursor (ruling 27723) and the last row written per path
  // (#29679 row 5) — is read HERE, before any kept row is produced, and written by `persistState` on
  // every round that reaches a verdict. Kept rows are produced above the batch: terminal close-request
  // filing, and the census refusal that preserves the WHOLE registry in one breath. Loading this later,
  // or persisting it only on the batch path, leaves a refused registry unremembered, so every restart
  // reprints it — the flood this rule exists to remove (@dev/review2, 2026-10-17).
  const hintPath = cursorHintPath(workdir)
  if (!progress.loaded) {
    progress.loaded = true
    try {
      const parsed: unknown = JSON.parse(readFileSync(hintPath, "utf8"))
      const hint =
        typeof parsed === "object" && parsed !== null && "cursorEnv" in parsed
          ? (parsed as { cursorEnv?: unknown }).cursorEnv
          : undefined
      if (typeof hint !== "string") throw new Error("no cursorEnv string")
      // The last-row map comes from the SAME document as the cursor: one state
      // file, one read. A malformed map throws with the cursor, so the whole
      // document is named and the sweep reprints once, never silently forgets.
      progress.reported = reportedFromState(parsed)
      progress.custodyRefusals = custodyRefusalsFromState(parsed)
      const index = inventory.rows.findIndex((row) => row.name === hint)
      if (index < 0) {
        record(
          hintPath,
          "cursor-reset",
          "resume hint names " + JSON.stringify(hint) + ", no longer a registered environment",
        )
        progress.cursor = 0
      } else progress.cursor = index
    } catch (cause) {
      const missing = (cause as NodeJS.ErrnoException).code === "ENOENT"
      progress.cursor = 0
      progress.reported = new Map()
      progress.custodyRefusals = new Map()
      const reason = missing
        ? "absent (first run), starting at index 0"
        : "unreadable (" + String(cause) + "), starting at index 0"
      io.stderr("yrd: environment cleanup resume hint " + hintPath + ": " + reason + "\n")
      if (!missing) record(hintPath, "cursor-reset", String(cause))
    }
  }
  /**
   * Write the sweep's own state: the resume cursor and the last row written per path, in ONE file. It
   * bounds the map to the registry this round walked, so a retired environment leaves no entry behind.
   */
  const persistState = (): void => {
    const live = new Set(inventory.rows.map((row) => row.path))
    progress.reported = new Map([...progress.reported].filter(([path]) => live.has(path)))
    progress.custodyRefusals = new Map([...progress.custodyRefusals].filter(([path]) => live.has(path)))
    // The retained cursor outlives the registry that set it: a round stops its batch at the registry's
    // last row and closes an environment, so the NEXT, smaller registry has no row at that index. The
    // batch re-normalizes the cursor only at its END, and the early verdicts — the withdrawal return and
    // the census refusal — persist BEFORE that. Normalize HERE, against the registry this round actually
    // walked, so every verdict persists the same bounded map instead of indexing past the end and saving
    // nothing, which reprints every unchanged keep on the restart (@dev/review2, 2026-10-17).
    const row = inventory.rows[progress.cursor % inventory.rows.length]
    if (row === undefined) {
      // The empty registry returned long before any caller reaches this point, so a missing row here is a
      // moved guard, never a normal state: loud, never the silent no-write that reprints the registry.
      throw new Error(
        `environment cleanup state: cursor ${progress.cursor} has no row in a ${inventory.rows.length}-row registry for ${registry}`,
      )
    }
    progress.cursor %= inventory.rows.length
    const cursorEnv = row.name
    progress.hint = cursorEnv
    try {
      mkdirSync(dirname(hintPath), { recursive: true })
      atomicWriteFileSync(
        hintPath,
        JSON.stringify({
          cursorEnv,
          runId: outcome.run,
          at: new Date().toISOString(),
          reported: Object.fromEntries(progress.reported),
          custodyRefusals: Object.fromEntries(progress.custodyRefusals),
        }) + "\n",
      )
    } catch (cause) {
      // A hint we cannot write is named, never silent; the sweep itself stands.
      record(hintPath, "cursor-write-failed", String(cause))
    }
  }
  // for the next consume.
  const startupSuppressed = new Set<string>()
  let resolvedPrimaryRoot: string | undefined
  await fileTerminalCloseRequests({
    workdir,
    rows: inventory.rows,
    terminal: [...outcome.merged, ...(input.withdrawn ?? [])],
    // The third inventory root holds detached exact-commit environments.
    branchRoots: inventory.roots.slice(0, 2),
    selection: input.selection,
    env: input.env,
    custodyRefusals: progress.custodyRefusals,
    suppressed: startupSuppressed,
    inspectCustodyFreshness: async (path, targetBranch, component) => {
      if (resolvedPrimaryRoot === undefined) {
        const primary = (await registeredWorktrees(registryGit))[0]
        if (primary === undefined) {
          return {
            status: "unknown",
            source: "persistent primary root",
            detail: `${registry}: native worktree registry has no primary checkout for component custody`,
          }
        }
        resolvedPrimaryRoot = primary.path
      }
      return createLocalGitWorktreeStore({ repo: registry, env: input.env }).inspectComponentCustodyFreshness(
        path,
        {
          primaryRoot: resolvedPrimaryRoot,
          targetBranch,
        },
        { component },
      )
    },
    record,
    preserve,
    automaticKeep,
    terminalHead: async (branch) => {
      const { history } = await historyOf(branch)
      const state = history?.state
      const withdrawn =
        input.withdrawn?.includes(branch) === true && state?.status === "cancelled" && state.reason === "withdrawn"
      if ((state?.status !== "merged" && !withdrawn) || state?.commit === undefined || state.tip === undefined) {
        throw new Error(
          `${store.remote}#${config.target.branch}: ${branch} has no exact merged or withdrawn submission head`,
        )
      }
      return {
        head: state.commit,
        ending: {
          remote: await remoteUrl(git, config.target.remote),
          queue: config.target.branch,
          branch,
          event: state.tip,
        },
      }
    },
  })
  // Withdrawal records only its exact terminal intent. The queue service is
  // the sole consumer; an interactive withdrawal must not sweep other jobs.
  if (input.withdrawn !== undefined) {
    persistState()
    return proofs
  }
  let snapshot: ProcessCwdProjection
  let primaryRoot: string
  try {
    snapshot = await census()
    // The service may stand in a linked landing. Git's first registration names
    // the persistent primary; the selected remover validates its identity.
    const primary = (await registeredWorktrees(registryGit))[0]
    if (primary === undefined) {
      throw new Error(`${registry}: native worktree registry has no primary checkout for component custody`)
    }
    primaryRoot = primary.path
  } catch (cause) {
    for (const row of inventory.rows) preserve(row.path, reasonText(cause))
    appendFileSync(
      outcome.log,
      `${JSON.stringify({ kind: "observation", run: outcome.run, at: new Date().toISOString(), scope: "environment-cleanup", registry, closed, kept, deferred: 0, remaining: inventory.rows.length - closed, ...(censusReceipt === undefined ? {} : { census: censusReceipt }) })}\n`,
    )
    // A refusal preserves the WHOLE registry with one reason: the map must remember it here, or the next
    // round writes the same ~50 rows again (@dev/review2, 2026-10-17).
    persistState()
    return proofs
  }
  // 22894: a close no caller here could certify is consumed BEFORE the cursor
  // batch, because this round is the context whose census reads every pid.
  const requests = await consumeCloseRequests({
    workdir,
    registry,
    primaryRoot,
    targetBranch: config.target.branch,
    custodyRefusals: progress.custodyRefusals,
    worktrees: registryGit,
    io,
    outcome,
    ...(input.onEnvironmentClosed === undefined ? {} : { onEnvironmentClosed: input.onEnvironmentClosed }),
    ...(input.releaseCheckout === undefined ? {} : { releaseCheckout: input.releaseCheckout }),
    readTip: (repository, branch) =>
      refAt(gitIn(repository, undefined, input.selection, { env: input.env }), `refs/heads/${branch}`),
  })
  proofs.push(...requests.proofs)
  closed += requests.closed
  const lookups = 0
  const startedAt = Date.now()
  // Resume where the last round ran out of budget, so a row that keeps failing
  // a cheap check cannot starve the tail of the registry.
  const offset = inventory.rows.length === 0 ? 0 : progress.cursor % inventory.rows.length
  const ordered = [...inventory.rows.slice(offset), ...inventory.rows.slice(0, offset)]
  let charged = 0
  let sweepAttempted = 0
  let stoppedAt = -1
  for (const [index, row] of ordered.entries()) {
    let closeTiming: Readonly<{ started_at: string; elapsed_ms: number }> | undefined
    try {
      if (requests.handled.has(row.path) || startupSuppressed.has(row.path)) {
        // This round already ran the direct close lifecycle for this path under a
        // filed request or suppressed an unchanged terminal custody refusal; evaluating it again here only repeats the census.
        continue
      }
      let entry = cache.get(row.path)
      if (entry === undefined) {
        entry = { paths: [], branches: [] }
        cache.set(row.path, entry)
      }
      const holder = busy(row.path, snapshot)
      if (entry.hold !== row.hold || entry.busy !== holder) entry.expensiveKey = undefined
      entry.hold = row.hold
      entry.busy = holder
      if (row.hold !== null) throw new Error(`held${row.hold === "" ? "" : `: ${row.hold}`}`)
      // Opening-record lookup spawns Git too: protected rows consume the batch.
      if (charged >= SWEEP_INSPECTION_BATCH) {
        stoppedAt = index
        break
      }
      charged++
      const openingGit = gitIn(row.path, undefined, git.selection, { env: input.env })
      const openingDir = (await openingGit(["rev-parse", "--absolute-git-dir"])).trim()
      const opening = readEnvOpenRecord(openingDir)
      throwIfStandingLifetime(opening)
      const protection = automaticKeep(row.path, opening)
      if (protection !== undefined) throw new Error(protection)
      const treeGit = gitIn(row.path, undefined, git.selection, { env: input.env })
      const head = row.head
      if (head === undefined) throw new Error(`registered environment ${row.path} has no HEAD`)
      if (entry.paths.length === 0) {
        for (const resource of ["index", "logs/HEAD"]) {
          const path = (await treeGit(["rev-parse", "--git-path", resource])).trim()
          if (path === "") throw new Error(`environment ${row.path}: Git returned no ${resource} path`)
          entry.paths.push({ path: resolve(row.path, path), optional: false })
        }
      }
      const ownLog = entry.paths[1]
      if (ownLog === undefined) throw new Error(`environment ${row.path}: HEAD reflog identity absent`)
      const bindingKey = async (): Promise<string> =>
        JSON.stringify([
          head,
          row.branch,
          config.blob,
          identity(ownLog),
          await Promise.all(
            [...new Set([...(row.branch === undefined ? [] : [row.branch]), ...entry.branches])].map(async (branch) => [
              branch,
              (await historyOf(branch)).history?.events.at(-1)?.id,
            ]),
          ),
        ])
      const key = await bindingKey()
      if (entry.bindingKey !== key) {
        entry.bindingKey = key
        entry.expensiveKey = undefined
      }
      if (holder !== undefined) throw new Error(holder)
      const expensiveKey = (): string =>
        JSON.stringify([
          head,
          row.branch,
          config.blob,
          outcome.target,
          entry.bindingKey,
          entry.paths.map((file) => [file.path, identity(file)]),
        ])
      if (entry.expensiveKey === expensiveKey()) {
        if (entry.verdict !== undefined) throw new Error(entry.verdict)
      } else {
        try {
          await proveEnvironmentRemovable({
            path: row.path,
            head,
            repo,
            env: input.env,
            target: outcome.target,
            originBranch: config.target.branch,
            treeGit,
            entry,
            ancestor,
          })
          entry.verdict = undefined
          entry.expensiveKey = expensiveKey()
        } catch (cause) {
          entry.verdict = String(cause)
          entry.expensiveKey = entry.retryRemoteProof ? undefined : expensiveKey()
          throw cause
        }
      }
      // A kept or refused close spends this route's allowance too.
      if (sweepAttempted >= CLOSE_ATTEMPTS_PER_ROUTE) {
        preserve(row.path, "eligible; yielding to the next queue round before removal")
        stoppedAt = index
        break
      }
      const freshHolder = busy(row.path, await census())
      if (freshHolder !== undefined) throw new Error(freshHolder)
      const current = (await environmentInventory(registry, registryGit, workdir)).rows.find(
        (entry) => entry.path === row.path,
      )
      if (current === undefined || current.hold !== null || current.head !== head) {
        throw new Error("registration, hold or HEAD changed before close")
      }
      const finalOpening = readEnvOpenRecord(openingDir)
      throwIfStandingLifetime(finalOpening)
      const finalProtection = automaticKeep(row.path, finalOpening)
      if (finalProtection !== undefined) throw new Error(finalProtection)
      let output = ""
      let closedProof: WorktreeRemovalProof | undefined
      const closeStartedAt = Date.now()
      const timing = { started_at: new Date(closeStartedAt).toISOString(), elapsed_ms: 0 }
      closeTiming = timing
      sweepAttempted++
      const exit = await closeEnvironment(
        row.path,
        {
          json: true,
          noRehome: true,
          componentCustody: { primaryRoot, targetBranch: config.target.branch },
        },
        {
          ...io,
          cwd: registry,
          stdout: (text) => {
            output += text
          },
        },
        undefined,
        // A sweep close is not asked for by anyone: an uncertifiable census is
        // the pre-22894 loud refusal, never a filed request (22894).
        "refuse",
        undefined,
        (proof) => {
          closedProof = proof
          proofs.push(proof)
        },
      ).finally(() => {
        timing.elapsed_ms = Date.now() - closeStartedAt
      })
      const failed = failedRetirements(output, row.path)
      if (exit !== 0 && failed === undefined) {
        // #27120 AC2: a refusal that names a class is still a refusal — the environment stays — but the
        // sweep reports it as one named class with its retire path, never as a per-seat note. A refusal
        // that names nothing still falls through to the loud throw below.
        const named = namedCloseRefusal(output)
        if (named !== undefined) {
          preserve(row.path, named, timing)
          continue
        }
        throw new Error(`native close exited ${exit}: ${output}`)
      }
      const result: unknown = JSON.parse(output)
      if (typeof result !== "object" || result === null) throw new Error(`malformed close result ${output}`)
      if ("closed" in result && result.closed === row.path) {
        closed++
        cache.delete(row.path)
        progress.custodyRefusals.delete(row.path)
        record(
          row.path,
          "closed",
          `native retained removal proof accepted${failed === undefined ? "" : `; branch retirement failed: ${failed.join("; ")}`}`,
          timing,
        )
        // Telling never gates the close (29720): the close is already
        // committed, so a telling failure is named here, at the source, and
        // never rethrown into the sweep's keep bookkeeping.
        try {
          await input.onEnvironmentClosed?.({
            ...(row.branch === undefined ? {} : { branch: row.branch }),
            head,
            path: row.path,
            ...(closedProof === undefined ? {} : { proof: closedProof }),
          })
        } catch (cause) {
          record(row.path, "tell-failed", `closed, but telling about it failed: ${reasonText(cause)}`)
        }
      } else if ("kept" in result && result.kept === row.path) {
        const custody = extractComponentCustody(result)
        const blockedRefusal = blockedCustodyRefusalRecord(custody, {
          head,
          branch: row.branch,
          targetBranch: config.target.branch,
          why: output.trim(),
        })
        if (blockedRefusal !== undefined) {
          progress.custodyRefusals.set(row.path, blockedRefusal)
        } else if (custody !== undefined) {
          progress.custodyRefusals.delete(row.path)
        }
        preserve(row.path, output.trim(), timing)
      } else throw new Error(`unproven close result ${output}`)
    } catch (cause) {
      preserve(row.path, namedPrivateStoreRefusal(cause, row.path) ?? reasonText(cause), closeTiming)
    }
  }
  progress.cursor = stoppedAt < 0 ? 0 : (offset + stoppedAt) % inventory.rows.length
  // The state is written in the same step as the round row that reports what the round did, so a
  // restart resumes at the next environment (ruling 27723) with the map the round actually wrote.
  persistState()
  appendFileSync(
    outcome.log,
    `${JSON.stringify({
      kind: "observation",
      run: outcome.run,
      at: new Date().toISOString(),
      scope: "environment-cleanup",
      registry,
      closed,
      kept,
      consumer: { attempted: requests.attempted, closed: requests.closed },
      sweep: { attempted: sweepAttempted, closed: closed - requests.closed },
      charged,
      deferred: inventory.rows.length - charged,
      remaining: inventory.rows.length - closed,
      ms: Date.now() - startedAt,
      lookups,
      ...(censusReceipt === undefined ? {} : { census: censusReceipt }),
    })}\n`,
  )
  return proofs
}
