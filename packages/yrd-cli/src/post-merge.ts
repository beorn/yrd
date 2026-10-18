import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createProcess } from "@yrd/process"
import { atomicWriteFileSync } from "@bearly/durable-file"
import {
  closingReferencesOf,
  enumerateChangeSegments,
  readBranchHistory,
  readEventQueue,
  readIssueEffect,
  issueProviderId,
  writeQueueEvent,
  isAncestor,
  trailer,
  type AppliedIssueEffect,
  type EventQueue,
  type GitRunner,
  type QueueLocation,
} from "@yrd/queue-core"
import { runIssuesVerb } from "./issues/run.ts"

// Real public Km CLI trial (2026-10-16, km-cli-trial.json): 1.246s for one
// closing action across two introduced commits, 0.739s unchanged catch-up.
// Allow 50/run at that measured whole-command cost (~62.3s), with nearly 2x
// margin. This is a bounded attempt, not a claim about worst-case workloads.
const UPDATE_TIMEOUT_MS = 120_000

type Context = Readonly<{
  code: string
  config: string
  repo: string
  queue: string
  target: string
  base?: string
  merged: readonly string[]
  update?: readonly string[]
  updateDue?: boolean
  projectRoot?: string
  queueBranch?: string
}>

type IssueDiagnostic = Readonly<{
  branch: string
  mergedEvent: string
  mergeSha: string
  providerId: string
  diagnostic: string
}>

type IssueAction = Omit<IssueDiagnostic, "diagnostic"> &
  (
    | { status: "fulfilled" }
    | { status: "skipped" }
    | { status: "failed" | "unavailable" | "record-failed"; diagnostic: string }
  )

/** The same attempt decoder serves recovery and the read-only diagnostic projection. */
function readPostMergeAttempt(
  path: string,
): Readonly<{ value: Record<string, unknown>; actions: readonly IssueAction[] }> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`post-merge attempt evidence unreadable at ${path}: ${String(error)}`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`post-merge attempt evidence malformed at ${path}: attempt is not an object`)
  }
  const attempt = raw as Record<string, unknown>
  const actions = attempt.issueActions === undefined ? [] : attempt.issueActions // legacy attempts predate issue actions
  if (!Array.isArray(actions)) {
    throw new Error(`post-merge attempt evidence malformed at ${path}: issueActions is not an array`)
  }
  for (const action of actions) {
    if (typeof action !== "object" || action === null || Array.isArray(action)) {
      throw new Error(`post-merge attempt evidence malformed at ${path}: issue action is not an object`)
    }
    const item = action as Record<string, unknown>
    if (
      typeof item.status !== "string" ||
      typeof item.branch !== "string" ||
      typeof item.mergedEvent !== "string" ||
      typeof item.mergeSha !== "string" ||
      typeof item.providerId !== "string"
    ) {
      throw new Error(
        `post-merge attempt evidence malformed at ${path}: issue action lacks status, branch, mergedEvent, mergeSha or providerId`,
      )
    }
    if (item.status === "skipped" || item.status === "fulfilled") continue
    if (item.status !== "failed" && item.status !== "unavailable" && item.status !== "record-failed") {
      throw new Error(`post-merge attempt evidence malformed at ${path}: unknown issue action status ${item.status}`)
    }
    if (typeof item.diagnostic !== "string") {
      throw new Error(`post-merge attempt evidence malformed at ${path}: failed issue action lacks diagnostic`)
    }
  }
  return { value: attempt, actions: actions as IssueAction[] }
}

/** Read-only projection; unread derived attempts are reported, never replay authority. */
export function readPostMergeIssueDiagnostics(
  workdir: string,
  reportUnavailable?: (message: string) => void,
): readonly IssueDiagnostic[] {
  const directory = join(workdir, "post-merge")
  if (!existsSync(directory)) return []
  const found = new Map<string, IssueDiagnostic>()
  let names: string[]
  try {
    names = readdirSync(directory).sort()
  } catch (error) {
    const diagnostic = `post-merge attempt evidence unreadable at ${directory}: ${String(error)}`
    if (reportUnavailable === undefined) throw new Error(diagnostic)
    reportUnavailable(diagnostic)
    return []
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const path = join(directory, name)
    let attempt: ReturnType<typeof readPostMergeAttempt>
    try {
      attempt = readPostMergeAttempt(path)
    } catch (error) {
      if (reportUnavailable === undefined) throw error
      reportUnavailable(String(error))
      continue
    }
    for (const item of attempt.actions) {
      const identity = JSON.stringify([item.branch, item.mergedEvent, item.mergeSha, item.providerId])
      if (item.status === "skipped" || item.status === "fulfilled") {
        if (item.status === "fulfilled") found.delete(identity)
        continue
      }
      found.set(identity, {
        branch: item.branch,
        mergedEvent: item.mergedEvent,
        mergeSha: item.mergeSha,
        providerId: item.providerId,
        diagnostic: item.diagnostic,
      })
    }
  }
  return [...found.values()]
}

async function closeMergedIssues(
  input: Readonly<{
    branches: readonly string[]
    queue: string
    store: QueueLocation
    git: GitRunner
    projectRoot: string
    workdir: string
    cwd: string
    env?: NodeJS.ProcessEnv
    report: (message: string) => void
    stop?: AbortSignal
    knownQueue?: EventQueue
  }>,
): Promise<Readonly<{ outcomes: Array<Record<string, unknown>>; queue?: EventQueue }>> {
  const outcomes: Array<Record<string, unknown>> = []
  let completed = input.knownQueue
  const seen = new Set<string>()

  for (const branch of new Set(input.branches)) {
    if (input.stop?.aborted) return { outcomes, queue: completed }
    try {
      const reading = await readBranchHistory(input.store, input.queue, branch)
      const history = reading.history
      if (history === undefined) throw new Error(`post-merge named branch ${branch} has no event history`)
      const segments = enumerateChangeSegments(history.events, reading.ref, input.store.repo)
      for (const segment of segments) {
        if (segment.state.status !== "merged" || segment.state.ending?.kind !== "merged") continue
        const mergedEvent = segment.events.findLast((event) => event.type === "merged")
        const mergeSha = segment.state.merge
        if (mergedEvent === undefined || mergeSha === undefined) {
          throw new Error(`${branch}: merged segment ${segment.opened} has no actual merged event or merge SHA`)
        }
        try {
          const observed = trailer(mergedEvent, "Reason") === `observed on target at ${mergeSha}`
          if (observed && !(await isAncestor(input.git, segment.head, mergeSha))) {
            throw new Error(
              `${branch}@${mergeSha}: submitted head ${segment.head} is not an ancestor of its observed delivery`,
            )
          }
          const phase = segment.events.findLast(
            (event) => event.type === "merging" && trailer(event, "Base") !== undefined,
          )
          const base = observed
            ? trailer(mergedEvent, "Base")
            : phase === undefined
              ? undefined
              : trailer(phase, "Base")
          const pinnedBlob = (
            await input.git(["ls-tree", "--format=%(objectname)", mergeSha, "--", "issues.yml"])
          ).trim()
          if (pinnedBlob === "") {
            outcomes.push({
              branch,
              mergedEvent: mergedEvent.id,
              mergeSha,
              providerId: "",
              status: "skipped",
              reason: "issues.yml absent at the delivered merge",
            })
            continue
          }
          if (base === undefined || base === "") {
            const diagnostic = `${branch}@${mergeSha}: actual merged commit has no provable historical base; only the known submitted commit was inspected, no introduced range was invented`
            let references = 0
            for await (const reference of closingReferencesOf(input.git, ["-1", segment.head], branch)) {
              references++
              outcomes.push({
                branch,
                mergedEvent: mergedEvent.id,
                mergeSha,
                providerId: issueProviderId(mergeSha, "resolve", undefined, reference.value),
                status: "failed",
                reason: "missing-base",
                raw: reference.value,
                diagnostic,
              })
            }
            if (references === 0) {
              outcomes.push({
                branch,
                mergedEvent: mergedEvent.id,
                mergeSha,
                providerId: "",
                status: "unavailable",
                reason: "missing-base",
                diagnostic,
              })
            }
            input.report(diagnostic)
            continue
          }
          const rawCommitterTime = (await input.git(["show", "-s", "--format=%cI", mergeSha])).trim()
          if (rawCommitterTime === "" || Number.isNaN(Date.parse(rawCommitterTime))) {
            throw new Error(`${branch}@${mergeSha}: actual merge committer time is unreadable`)
          }
          const committerTime = new Date(rawCommitterTime).toISOString()
          for (const event of history.events) {
            const applied = readIssueEffect(event)
            if (
              applied?.mergedEvent === mergedEvent.id &&
              applied.mergeSha === mergeSha &&
              applied.declaration.blob !== pinnedBlob
            ) {
              throw new Error(
                `${branch}@${mergeSha}: applied declaration blob ${applied.declaration.blob} differs from pinned ${pinnedBlob}`,
              )
            }
          }
          const references = async function* () {
            yield* closingReferencesOf(input.git, [`${base}..${observed ? segment.head : mergeSha}`], branch)
            if (observed && mergeSha !== segment.head) yield* closingReferencesOf(input.git, ["-1", mergeSha], branch)
          }
          const refs = references()
          for await (const reference of refs) {
            if (input.stop?.aborted) return { outcomes, queue: completed }
            const resolved = await runIssuesVerb({
              verb: "resolve",
              args: [reference.value],
              projectRoot: input.projectRoot,
              declarationCommit: mergeSha,
              cwd: input.cwd,
              env: input.env,
              timeoutMs: UPDATE_TIMEOUT_MS,
              signal: input.stop,
              noProgressTimeoutMs: UPDATE_TIMEOUT_MS,
            })
            if (!resolved.ok) {
              const providerId = issueProviderId(mergeSha, "resolve", undefined, reference.value)
              const diagnostic = resolved.message
              outcomes.push({
                branch,
                mergedEvent: mergedEvent.id,
                mergeSha,
                providerId,
                status: "failed",
                diagnostic,
                raw: reference.value,
              })
              input.report(`issuesProvider.resolve failed for ${branch}@${mergeSha}: ${diagnostic}`)
              continue
            }
            const keys = (resolved.envelope.result as { keys: string[] }).keys
            // Resolving this same raw reference again clears its earlier derived failure,
            // independently of the opaque keys it now names. No applied effect is granted.
            outcomes.push({
              branch,
              mergedEvent: mergedEvent.id,
              mergeSha,
              providerId: issueProviderId(mergeSha, "resolve", undefined, reference.value),
              raw: reference.value,
              status: "fulfilled",
            })
            for (const key of keys) {
              const providerId = issueProviderId(mergeSha, "close", "completed", key)
              if (seen.has(providerId)) continue
              seen.add(providerId)
              completed = await readEventQueue(input.store, input.queue, { knownQueue: completed })
              const fulfilled = completed.issueEffects[providerId]
              if (fulfilled !== undefined) {
                if (fulfilled.effect.declaration.blob !== pinnedBlob) {
                  throw new Error(
                    `${branch}@${mergeSha}: applied declaration blob ${fulfilled.effect.declaration.blob} differs from pinned ${pinnedBlob}`,
                  )
                }
                outcomes.push({ branch, mergedEvent: mergedEvent.id, mergeSha, providerId, status: "fulfilled" })
                continue
              }
              const closed = await runIssuesVerb({
                verb: "close",
                args: [key, "completed"],
                id: providerId,
                projectRoot: input.projectRoot,
                declarationCommit: mergeSha,
                cwd: input.cwd,
                env: input.env,
                signal: input.stop,
                timeoutMs: UPDATE_TIMEOUT_MS,
                noProgressTimeoutMs: UPDATE_TIMEOUT_MS,
              })
              if (!closed.ok) {
                const diagnostic = closed.message
                outcomes.push({
                  branch,
                  mergedEvent: mergedEvent.id,
                  mergeSha,
                  providerId,
                  status: "failed",
                  diagnostic,
                })
                input.report(
                  `issuesProvider.close ${JSON.stringify(key)} failed for ${branch}@${mergeSha}: ${diagnostic}`,
                )
                continue
              }
              try {
                const declarationBlob = (
                  await input.git.at(closed.envelope.declaration.repository)([
                    "rev-parse",
                    `${closed.envelope.declaration.commit}:issues.yml`,
                  ])
                ).trim()
                if (declarationBlob === "") {
                  throw new Error(`issues.yml blob is unreadable at ${closed.envelope.declaration.commit}`)
                }
                const issueEffect: AppliedIssueEffect = {
                  kind: "issue-effect-v1",
                  mergedEvent: mergedEvent.id,
                  mergeSha,
                  mergeCommitterTime: committerTime,
                  verb: "close",
                  semanticEnding: "completed",
                  issueKey: key,
                  providerId,
                  declaration: { path: "issues.yml", blob: declarationBlob },
                }
                try {
                  await writeQueueEvent(input.store, input.queue, {
                    type: "notified",
                    at: new Date(),
                    by: "yrd-run",
                    issueEffect,
                  })
                } catch (error) {
                  // A rival append or lost publication reply can already have fulfilled this identity.
                  completed = await readEventQueue(input.store, input.queue, { knownQueue: completed })
                  if (completed.issueEffects[providerId] === undefined) throw error
                }
                outcomes.push({ branch, mergedEvent: mergedEvent.id, mergeSha, providerId, status: "fulfilled" })
              } catch (error) {
                const diagnostic = `provider succeeded but applied effect could not be recorded: ${String(error)}`
                outcomes.push({
                  branch,
                  mergedEvent: mergedEvent.id,
                  mergeSha,
                  providerId,
                  status: "record-failed",
                  diagnostic,
                })
                input.report(`${branch}@${mergeSha}: ${diagnostic}`)
              }
            }
          }
        } catch (error) {
          const diagnostic = String(error)
          outcomes.push({ branch, mergedEvent: mergedEvent.id, mergeSha, providerId: "", status: "failed", diagnostic })
          input.report(`${branch}@${mergeSha}: issue close failed: ${diagnostic}`)
        }
      }
    } catch (error) {
      const diagnostic = String(error)
      outcomes.push({ branch, mergedEvent: "", mergeSha: "", providerId: "", status: "unavailable", diagnostic })
      input.report(`${branch}: issue close history unavailable: ${diagnostic}`)
    }
  }
  return { outcomes, queue: completed }
}

/** Private sequential housekeeping. Derived attempt evidence never supplies replay authority. */
export function createPostMerge<C extends Context>(
  options: Readonly<{
    workdir: string
    cwd: string
    env?: NodeJS.ProcessEnv
    stop?: AbortSignal
    cleanup: (context: C) => Promise<void>
    report: (message: string) => void
    git?: GitRunner
    store?: QueueLocation
  }>,
) {
  const directory = join(options.workdir, "post-merge")
  const evidenceFailures = new Set<string>()
  const evidence = (path: string, write: () => void): void => {
    try {
      write()
    } catch (error) {
      if (!evidenceFailures.has(path)) {
        options.report("post-merge evidence unavailable at " + path + ": " + String(error))
      }
      evidenceFailures.add(path)
    }
  }
  evidence(directory, () => {
    mkdirSync(directory, { recursive: true })
  })
  // Called only after this service has acquired its existing queue ownership.
  // Only labels are repaired: neither update nor cleanup decides from these bytes.
  const recover = (): void => {
    let previousNames: string[] = []
    evidence(directory, () => {
      previousNames = readdirSync(directory)
    })
    for (const name of previousNames) {
      if (!name.endsWith(".json")) continue
      const path = join(directory, name)
      try {
        const previous = readPostMergeAttempt(path).value
        if (previous.status === "running") {
          atomicWriteFileSync(
            path,
            JSON.stringify({ ...previous, status: "interrupted", interruptedAt: new Date().toISOString() }) + "\n",
          )
        }
      } catch (error) {
        options.report("post-merge evidence unavailable at " + path + ": " + String(error))
      }
    }
  }
  const process = createProcess({ cwd: options.cwd, env: options.env })
  let pending: C | undefined
  let active: Promise<void> | undefined
  let closing = false
  // The existing service stays resident: keep only its last validated snapshot across sequential attempts.
  let completedQueue: Readonly<{ branch: string; value: EventQueue }> | undefined
  const dropPending = (): void => {
    if (pending === undefined) return
    options.report(
      JSON.stringify(pending.merged) +
        ": pending post-merge attempt dropped during shutdown; startup catch-up handles remaining environment rows; branches without rows need branch triage",
    )
    pending = undefined
  }
  const attempt = async (context: C): Promise<void> => {
    const id = new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID()
    const path = join(directory, id + ".json")
    const stdout = join(directory, id + ".stdout.log")
    const stderr = join(directory, id + ".stderr.log")
    const startedAt = new Date().toISOString()
    const provenance = { ...context, argv: context.update ?? [], cwd: options.cwd, startedAt, stdout, stderr }
    evidence(stdout, () => {
      writeFileSync(stdout, "")
    })
    evidence(stderr, () => {
      writeFileSync(stderr, "")
    })
    evidence(path, () => {
      atomicWriteFileSync(path, JSON.stringify({ ...provenance, status: "running" }) + "\n")
    })
    let issueActions: Array<Record<string, unknown>> = []
    let settled: Record<string, unknown> = {
      status: "skipped",
      reason:
        context.update === undefined ? "no issuesProvider.update declared" : "no provider update due for idle round",
    }
    try {
      try {
        if (context.update !== undefined && context.updateDue !== false) {
          const result = await process.run({
            argv: context.update,
            cwd: options.cwd,
            timeoutMs: UPDATE_TIMEOUT_MS,
            signal: options.stop,
            onOutput: ({ stream, chunk }) => {
              const output = stream === "stdout" ? stdout : stderr
              evidence(output, () => {
                appendFileSync(output, chunk)
              })
            },
          })
          const failed =
            result.exitCode !== 0 ||
            result.signal !== null ||
            result.timedOut ||
            result.stalled ||
            result.escapedDescendant ||
            result.sweepFailure !== undefined
          settled = {
            status: failed ? "failed" : "succeeded",
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            stalled: result.stalled,
            sweepFailure: result.sweepFailure,
            escapedDescendant: result.escapedDescendant,
          }
          if (failed) {
            options.report(
              "issuesProvider.update " +
                JSON.stringify(context.update) +
                " failed: exit " +
                result.exitCode +
                ", signal " +
                result.signal +
                ", timeout " +
                result.timedOut +
                "; " +
                stderr,
            )
          }
        }
      } catch (error) {
        settled = { status: "unavailable", reason: String(error) }
        options.report(
          "issuesProvider.update " + JSON.stringify(context.update) + " unavailable: " + String(error) + "; " + stderr,
        )
      }
      if (
        context.merged.length > 0 &&
        options.git !== undefined &&
        options.store !== undefined &&
        context.projectRoot !== undefined &&
        context.queueBranch !== undefined
      ) {
        const closed = await closeMergedIssues({
          branches: context.merged,
          queue: context.queueBranch,
          store: options.store,
          git: options.git,
          projectRoot: context.projectRoot,
          workdir: options.workdir,
          cwd: options.cwd,
          env: options.env,
          report: options.report,
          stop: options.stop,
          knownQueue: completedQueue?.branch === context.queueBranch ? completedQueue.value : undefined,
        })
        issueActions = closed.outcomes
        if (
          issueActions.some(
            ({ status }) => status === "failed" || status === "unavailable" || status === "record-failed",
          )
        ) {
          settled = { ...settled, status: "failed" }
        }
        if (closed.queue !== undefined) completedQueue = { branch: context.queueBranch, value: closed.queue }
      } else if (context.merged.length > 0 && context.projectRoot === undefined) {
        options.report(
          "automatic issue close skipped: pass --project-root <path> to opt in; issues.yml must be committed at the delivered merge in that repository",
        )
      } else if (context.merged.length > 0) {
        const missing = [
          ...(options.git === undefined ? ["git"] : []),
          ...(options.store === undefined ? ["store"] : []),
          ...(context.queueBranch === undefined ? ["queueBranch"] : []),
        ]
        const reason = `automatic issue close unavailable: explicit projectRoot ${context.projectRoot} has missing input(s): ${missing.join(", ")}`
        settled = { status: "unavailable", reason }
        options.report(reason)
      }
    } catch (error) {
      const reason = "post-merge issue close attempt unavailable: " + String(error)
      settled = { status: "unavailable", reason }
      options.report(reason)
    } finally {
      evidence(path, () => {
        atomicWriteFileSync(
          path,
          JSON.stringify({ ...provenance, ...settled, issueActions, endedAt: new Date().toISOString() }) + "\n",
        )
      })
      try {
        await options.cleanup(context)
      } catch (error) {
        options.report(
          "post-merge cleanup failed for " + context.target + "; retained for the next catch-up: " + String(error),
        )
      }
    }
  }
  const pump = async (): Promise<void> => {
    while (pending !== undefined && !options.stop?.aborted) {
      const next = pending
      pending = undefined
      await attempt(next)
    }
    if (options.stop?.aborted) dropPending()
  }
  const start = (): void => {
    active = pump()
      .catch((error) => options.report("post-merge attempt failed: " + String(error)))
      .finally(() => {
        active = undefined
        if (pending !== undefined && !options.stop?.aborted) start()
      })
  }
  const nudge = (context: C): void => {
    if (closing) return
    pending =
      pending === undefined
        ? context
        : {
            ...context,
            merged: [...new Set([...pending.merged, ...context.merged])],
            updateDue: (context.updateDue ?? true) || (pending.updateDue ?? true),
          }
    if (active !== undefined) return
    start()
  }
  const drain = async (): Promise<void> => {
    while (active !== undefined) await active
  }
  const close = async (): Promise<void> => {
    closing = true
    if (options.stop !== undefined) {
      dropPending()
      await process.close()
    }
    await drain()
    await process.close()
  }
  return { nudge, recover, [Symbol.asyncDispose]: close }
}
