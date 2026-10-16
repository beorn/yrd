import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createProcess } from "@yrd/process"

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
}>

/** Private sequential housekeeping. Derived attempt evidence never supplies replay authority. */
export function createPostMerge<C extends Context>(
  options: Readonly<{
    workdir: string
    cwd: string
    env?: NodeJS.ProcessEnv
    stop?: AbortSignal
    cleanup: (context: C) => Promise<void>
    report: (message: string) => void
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
    let settled: Record<string, unknown> = {
      status: "skipped",
      reason:
        context.update === undefined ? "no issuesProvider.update declared" : "no provider update due for idle round",
    }
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
    } finally {
      evidence(path, () => {
        writeFileSync(path, JSON.stringify({ ...provenance, ...settled, endedAt: new Date().toISOString() }) + "\n")
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
    if (options.stop?.aborted) pending = undefined
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
      pending = undefined
      await process.close()
    }
    await drain()
    await process.close()
  }
  return { nudge, recover, [Symbol.asyncDispose]: close }
}
