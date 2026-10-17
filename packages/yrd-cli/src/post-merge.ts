import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { createProcess } from "@yrd/process"
import {
  appendChangeEvent,
  closingReferencesOf,
  Conflict,
  enumerateChangeSegments,
  readBranchHistory,
  readIssueEffect,
  trailer,
  type AppliedIssueEffect,
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

/** Read-only queue-status projection. These records never grant replay authority. */
export function readPostMergeIssueDiagnostics(workdir: string): readonly IssueDiagnostic[] {
  const directory = join(workdir, "post-merge")
  if (!existsSync(directory)) return []
  const found: IssueDiagnostic[] = []
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue
    const path = join(directory, name)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
      throw new Error(`post-merge attempt evidence unreadable at ${path}: ${String(error)}`)
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue
    const attempt = raw as Record<string, unknown>
    if (attempt.issueActions === undefined) continue // legacy attempts predate issue actions
    if (!Array.isArray(attempt.issueActions)) {
      throw new Error(`post-merge attempt evidence malformed at ${path}: issueActions is not an array`)
    }
    for (const action of attempt.issueActions) {
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
      if (item.status !== "failed" && item.status !== "unavailable" && item.status !== "record-failed") continue
      if (typeof item.diagnostic !== "string") {
        throw new Error(`post-merge attempt evidence malformed at ${path}: failed issue action lacks diagnostic`)
      }
      found.push({
        branch: item.branch,
        mergedEvent: item.mergedEvent,
        mergeSha: item.mergeSha,
        providerId: item.providerId,
        diagnostic: item.diagnostic,
      })
    }
  }
  return found
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
  }>,
): Promise<Array<Record<string, unknown>>> {
  const outcomes: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const hasEffect = (events: readonly import("@yrd/queue-core").Event[], providerId: string): boolean =>
    events.some((event) => readIssueEffect(event)?.providerId === providerId)

  for (const branch of new Set(input.branches)) {
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
      const historicalBase = segment.events.findLast(
        (event) => event.id !== mergedEvent.id && trailer(event, "Base") !== undefined,
      )
      const base =
        historicalBase === undefined
          ? (await input.git(["rev-parse", `${mergeSha}^1`])).trim()
          : (trailer(historicalBase, "Base") as string)
      if (base === "") throw new Error(`${branch}@${mergeSha}: actual merged commit has no provable historical base`)
      const rawCommitterTime = (await input.git(["show", "-s", "--format=%cI", mergeSha])).trim()
      if (rawCommitterTime === "" || Number.isNaN(Date.parse(rawCommitterTime))) {
        throw new Error(`${branch}@${mergeSha}: actual merge committer time is unreadable`)
      }
      const committerTime = new Date(rawCommitterTime).toISOString()
      const refs = closingReferencesOf(input.git, [`${base}..${mergeSha}`], branch)
      for await (const reference of refs) {
        const resolved = await runIssuesVerb({
          verb: "resolve",
          args: [reference.value],
          projectRoot: input.projectRoot,
          cwd: input.cwd,
          env: input.env,
          timeoutMs: UPDATE_TIMEOUT_MS,
          signal: input.stop,
          noProgressTimeoutMs: UPDATE_TIMEOUT_MS,
        })
        if (!resolved.ok) {
          const providerId =
            "yrd1-" +
            createHash("sha256")
              .update(JSON.stringify([mergeSha, "resolve", null, reference.value]))
              .digest("hex")
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
        for (const key of keys) {
          const providerId =
            "yrd1-" +
            createHash("sha256")
              .update(JSON.stringify([mergeSha, "close", "completed", key]))
              .digest("hex")
          if (seen.has(providerId)) continue
          seen.add(providerId)
          let fresh = await readBranchHistory(input.store, input.queue, branch)
          if (fresh.history === undefined) {
            throw new Error(`post-merge branch ${branch} lost its history before recording ${providerId}`)
          }
          if (hasEffect(fresh.history.events, providerId)) {
            outcomes.push({ branch, mergedEvent: mergedEvent.id, mergeSha, providerId, status: "fulfilled" })
            continue
          }
          const closed = await runIssuesVerb({
            verb: "close",
            args: [key, "completed"],
            id: providerId,
            projectRoot: input.projectRoot,
            cwd: input.cwd,
            env: input.env,
            signal: input.stop,
            timeoutMs: UPDATE_TIMEOUT_MS,
            noProgressTimeoutMs: UPDATE_TIMEOUT_MS,
          })
          if (!closed.ok) {
            const diagnostic = closed.message
            outcomes.push({ branch, mergedEvent: mergedEvent.id, mergeSha, providerId, status: "failed", diagnostic })
            input.report(`issuesProvider.close ${JSON.stringify(key)} failed for ${branch}@${mergeSha}: ${diagnostic}`)
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
            let recorded = false
            for (let retry = 0; retry < 4 && !recorded; retry++) {
              fresh = await readBranchHistory(input.store, input.queue, branch)
              if (fresh.history === undefined) {
                throw new Error(`post-merge branch ${branch} lost its history while recording ${providerId}`)
              }
              const selectedTip = fresh.history.state.tip
              if (selectedTip === undefined) {
                throw new Error(`post-merge branch ${branch} has no event tip while recording ${providerId}`)
              }
              if (hasEffect(fresh.history.events, providerId)) {
                recorded = true
                break
              }
              try {
                await appendChangeEvent(input.store, input.queue, branch, selectedTip, {
                  type: "notified",
                  at: new Date(),
                  commit: mergeSha,
                  writer: "yrd-run",
                  issueEffect,
                })
                recorded = true
              } catch (error) {
                // A rival append may have fulfilled this identity while the provider ran.
                const after = await readBranchHistory(input.store, input.queue, branch)
                if (after.history !== undefined && hasEffect(after.history.events, providerId)) recorded = true
                else if (!(error instanceof Conflict) || retry === 3) throw error
              }
            }
            if (!recorded) throw new Error(`could not append applied issue effect ${providerId}`)
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
    }
  }
  return outcomes
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
        const previous: unknown = JSON.parse(readFileSync(path, "utf8"))
        if (typeof previous !== "object" || previous === null || Array.isArray(previous)) {
          throw new Error("attempt evidence is not an object")
        }
        if ((previous as Record<string, unknown>).status === "running") {
          writeFileSync(
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
      writeFileSync(path, JSON.stringify({ ...provenance, status: "running" }) + "\n")
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
        issueActions = await closeMergedIssues({
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
        })
      } else if (context.merged.length > 0 && context.projectRoot === undefined) {
        options.report("automatic issue close skipped: this queue invocation has no explicit projectRoot")
      }
    } catch (error) {
      options.report("post-merge issue close attempt unavailable: " + String(error))
    } finally {
      evidence(path, () => {
        writeFileSync(
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
