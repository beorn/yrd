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
 *
 * The environment is built, never inherited (ruling A7), and it says what the
 * check is judging: `YRD_REPO` is the worktree the check runs in, its own
 * working directory; `YRD_CANDIDATE_SHA` is that worktree's HEAD; `YRD_BASE_SHA`
 * is the merge base of that HEAD and the target, so it is always an ancestor
 * of the candidate. A check that selects work by what changed — the affected
 * tests, the co-changed manifests — needs both shas and needs that ancestry, so
 * the queue states them rather than leaving each check to derive them by shell
 * against whatever refs its worktree happens to carry. They are read once per
 * worktree (worktree.ts) and the same for every program that runs in it, the
 * `setup:` included.
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

/** The environment every check gets, by name; `LC_*` and the check's own `environmentPassthrough` join it. */
const BASE_ENV = ["PATH", "HOME", "SHELL", "LANG", "USER", "LOGNAME"] as const

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

/**
 * What the tree a program judges IS, read once when the worktree was prepared
 * and the same for every check and setup that runs in it.
 */
export type CheckedTree = Readonly<{
  /** `YRD_CANDIDATE_SHA`: the worktree's HEAD — the change's head at submit, the merge commit at merge, the target itself at the target. */
  candidate: string
  /** `YRD_BASE_SHA`: the merge base of that HEAD and the target, so it is always an ancestor of the candidate. */
  base: string
}>

export type RunCheck = Readonly<{
  spec: CheckSpec
  /** The change's worktree. */
  cwd: string
  /** What that worktree holds, as the check is told it. */
  tree: CheckedTree
  /** Where this check's log is written. */
  logDir: string
  /** A scratch root on the root filesystem, never a shared tmpfs. */
  scratch: string
  process?: Process
  env?: NodeJS.ProcessEnv
}>

/**
 * Where a check's log goes, from the directory its phase writes into and the
 * check's own name. One reading of the two, so a caller can say where the log
 * will be before the check has written a byte of it: the row that says a check
 * STARTED names the same file the row that says it ended names.
 */
export function checkLogPath(logDir: string, name: string): string {
  return join(logDir, `${name}.log`)
}

export async function runCheck(run: RunCheck): Promise<CheckResult> {
  mkdirSync(run.logDir, { recursive: true })
  mkdirSync(run.scratch, { recursive: true })
  const log = checkLogPath(run.logDir, run.spec.name)
  const runner = run.process ?? createProcess({ cwd: run.cwd })
  // The check's environment is built, never inherited: a fixed base a real
  // check needs (measured on the root's own checks), the scratch root as
  // TMPDIR, and whatever the check declares. Nothing else reaches the child.
  const source = run.env ?? process.env
  const env: NodeJS.ProcessEnv = { TMPDIR: run.scratch }
  for (const name of [...BASE_ENV, ...(run.spec.environmentPassthrough ?? [])]) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith("LC_") && value !== undefined) env[name] = value
  }
  // Last, so they cannot be inherited over: what the check is judging is the
  // queue's own statement about the tree it just prepared, and a check told a
  // stale base by the environment would select the wrong work and say nothing.
  env.YRD_REPO = run.cwd
  env.YRD_CANDIDATE_SHA = run.tree.candidate
  env.YRD_BASE_SHA = run.tree.base
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
