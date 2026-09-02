/**
 * One check, run here, now ([plan](../../../../pm/@i/10-yrd/plan.md)
 * § The final design, The queue run).
 *
 * A check is a command the target declares, run in a change's worktree with a
 * bound. Its result is one of three words, read off the exit code and nothing
 * else: 0 is pass, 1 is fail, 2 is stuck — the check's own statement that it
 * could not judge. A check that is not there, one that runs past its bound, or
 * one that exits with any other code could not judge either, and that is the
 * queue's fault until proven otherwise, so it is stuck too. Every result names
 * the check, its exit, its duration and its log path, because a result nobody
 * can read is not a result.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createProcess, shellCommand, type Process } from "@yrd/process"

/** A check as the target declares it. */
export type CheckSpec = Readonly<{
  name: string
  /** The command, run through the shell in the change's worktree. */
  run: string
  /** The bound; the plan's default is thirty minutes. */
  timeoutMs?: number
  /** Environment names passed through from the queue's own environment. */
  environmentPassthrough?: readonly string[]
}>

export const DEFAULT_CHECK_BOUND_MS = 30 * 60 * 1000

export type CheckResult = Readonly<{
  name: string
  result: "pass" | "fail" | "stuck"
  /** The exit code, or the word for what ended it when there was none. */
  exit: number | "timeout" | "signal" | "missing"
  durationMs: number
  /** Where stdout and stderr went, one file per attempt. */
  log: string
  /** Why, when the result is stuck. */
  why?: string
}>

export type RunCheck = Readonly<{
  spec: CheckSpec
  /** The change's worktree. */
  cwd: string
  /** Where this check's log is written. */
  logDir: string
  /** A scratch root on the root filesystem, never a shared tmpfs. */
  scratch: string
  process?: Process
  env?: NodeJS.ProcessEnv
}>

export async function runCheck(run: RunCheck): Promise<CheckResult> {
  mkdirSync(run.logDir, { recursive: true })
  mkdirSync(run.scratch, { recursive: true })
  const log = join(run.logDir, `${run.spec.name}.log`)
  const runner = run.process ?? createProcess({ cwd: run.cwd })
  const env: NodeJS.ProcessEnv = { PATH: (run.env ?? process.env).PATH, TMPDIR: run.scratch }
  for (const name of run.spec.environmentPassthrough ?? []) {
    const value = (run.env ?? process.env)[name]
    if (value !== undefined) env[name] = value
  }
  const timeoutMs = run.spec.timeoutMs ?? DEFAULT_CHECK_BOUND_MS
  const started = Date.now()
  const result = await runner.run({ argv: shellCommand(run.spec.run), cwd: run.cwd, env, timeoutMs })
  const durationMs = Date.now() - started
  writeFileSync(log, `${result.stdout}${result.stderr === "" ? "" : `\n--- stderr ---\n${result.stderr}`}`)

  const base = { durationMs, log, name: run.spec.name }
  if (result.timedOut) {
    return { ...base, exit: "timeout", result: "stuck", why: `ran past its bound of ${timeoutMs} ms` }
  }
  if (result.signal !== null) {
    return { ...base, exit: "signal", result: "stuck", why: `ended by ${result.signal}` }
  }
  // 127 is the shell's own word for a command it could not find: the check is
  // not there, which is the queue's fault, not the submitter's.
  if (result.exitCode === 127) {
    return { ...base, exit: "missing", result: "stuck", why: `the check command was not found: ${run.spec.run}` }
  }
  switch (result.exitCode) {
    case 0:
      return { ...base, exit: 0, result: "pass" }
    case 1:
      return { ...base, exit: 1, result: "fail" }
    case 2:
      return { ...base, exit: 2, result: "stuck", why: "the check said it could not judge" }
    default:
      return { ...base, exit: result.exitCode, result: "stuck", why: `exit ${result.exitCode} is not a verdict` }
  }
}
