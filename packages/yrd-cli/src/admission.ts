import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createProcess, shellCommand, type ProcessResult } from "@yrd/process"
import { freshWorktree, type AdmissionVerdict, type Git, type QueueConfig } from "@yrd/queue-core"

function cannotJudge(command: string, reason: string, stderr = ""): AdmissionVerdict {
  return {
    kind: "cannot-judge",
    reason:
      `target .yrd.yml admission ${JSON.stringify(command)} could not judge: ${reason}` +
      (stderr.trim() === "" ? "" : `; stderr: ${stderr.trim()}`),
  }
}

/** Interpret the command's complete process result; incomplete output cannot decide policy. */
export function admissionVerdict(result: ProcessResult, run: string, timeoutMs: number): AdmissionVerdict {
  if (result.timedOut) return cannotJudge(run, `timed out after ${timeoutMs}ms`, result.stderr)
  if (
    result.stalled ||
    result.escapedDescendant ||
    result.sweepFailure !== undefined ||
    result.outputTruncation !== undefined
  ) {
    return cannotJudge(run, `process did not settle cleanly (exit ${result.exitCode})`, result.stderr)
  }
  if (result.signal !== null) {
    return cannotJudge(run, `exit ${result.exitCode}, signal ${String(result.signal)}`, result.stderr)
  }
  if (result.exitCode === 0) return { kind: "admit" }
  if (result.exitCode === 1) {
    const reason = result.stdout.trim()
    return {
      kind: "refuse",
      reason: reason === "" ? `target .yrd.yml admission ${JSON.stringify(run)} refused without a stdout cure` : reason,
    }
  }
  if (result.exitCode === 3) {
    const reason = result.stdout.trim()
    return {
      kind: "warn",
      reason:
        reason === ""
          ? `target .yrd.yml admission ${JSON.stringify(run)} warned without a stdout cure; print the failing policy row and its cure`
          : reason,
    }
  }
  return cannotJudge(run, `exit ${result.exitCode}`, result.stderr)
}

/** Run only target-declared policy in a detached worktree of the captured target. */
export async function runAdmission(
  git: Git,
  repo: string,
  workdir: string,
  targetHead: string,
  config: NonNullable<QueueConfig["admission"]>,
  payload: Readonly<{ issue: string; branch: string; head: string }>,
  env: NodeJS.ProcessEnv = process.env,
  populateReference = false,
): Promise<AdmissionVerdict> {
  const parent = join(workdir, "admission")
  mkdirSync(parent, { recursive: true })
  const scratch = mkdtempSync(join(parent, "run-"))
  try {
    await using process = createProcess({ cwd: repo, env })
    const tree = await freshWorktree(git, repo, targetHead, join(scratch, "target"), {
      process,
      env,
      populateReference,
    })
    try {
      const admissionEnv = {
        ...env,
        YRD_ADMISSION_ISSUE: payload.issue,
        YRD_ADMISSION_BRANCH: payload.branch,
        YRD_ADMISSION_HEAD: payload.head,
      }
      const result = await process.run({
        argv: shellCommand(config.run),
        cwd: tree.path,
        env: admissionEnv,
        timeoutMs: config.timeoutMs,
      })
      return admissionVerdict(result, config.run, config.timeoutMs)
    } finally {
      await tree.remove()
    }
  } catch (cause) {
    return cannotJudge(config.run, `target ${targetHead} at ${repo} could not run: ${String(cause)}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
