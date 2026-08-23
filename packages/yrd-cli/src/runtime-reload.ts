import { createFailure, raiseFailure } from "@yrd/core"

type YrdProcessExecve = (execPath: string, argv: readonly string[], env: NodeJS.ProcessEnv) => never

/** The exec env variable that carries how many consecutive in-place reloads
 * the lineage of one habitant pid has performed. A same-PID `execve` keeps
 * argv and env, so without this nothing counts and a plan the source can
 * never build — or a tip that keeps moving — would spin the habitant through
 * reload after reload, each one recording the finding and none of them ever
 * refusing. */
export const YRD_RUNTIME_RELOADS_ENV = "YRD_RUNTIME_RELOADS"

/** Consecutive in-place reloads a lineage may perform before the gate refuses
 * with `installed-plan-reload-exhausted` instead of reloading again. Three is
 * enough for the ordinary case (one config merge, one reload) with room for
 * a second merge that races the first; a fourth stale gate in a row is a
 * loop, not a transition. */
export const MAX_CONSECUTIVE_RUNTIME_RELOADS = 3

/** How many consecutive in-place reloads the lineage this process belongs to
 * has performed, as the exec env records it. Absent means none — a process
 * its supervisor started by hand. Anything that is not a non-negative integer
 * is loud: a corrupted count cannot bound anything. */
export function consecutiveRuntimeReloads(env: NodeJS.ProcessEnv): number {
  const raw = env[YRD_RUNTIME_RELOADS_ENV]
  if (raw === undefined || raw === "") return 0
  if (!/^\d{1,9}$/u.test(raw)) {
    raiseFailure(
      "configuration",
      "runtime-reloads-invalid",
      `yrd: ${YRD_RUNTIME_RELOADS_ENV}='${raw}' is not a non-negative integer, so consecutive in-place reloads ` +
        "cannot be bounded. Unset it and restart the habitant by hand.",
    )
  }
  return Number(raw)
}

/** The env a replacement process is exec'd with: the caller's env plus the
 * count it starts from. */
export function withRuntimeReloads(env: NodeJS.ProcessEnv, reloads: number): NodeJS.ProcessEnv {
  if (!Number.isSafeInteger(reloads) || reloads < 1) {
    throw new RangeError(`yrd: a replacement process starts at reload 1 or later, not ${String(reloads)}`)
  }
  return { ...env, [YRD_RUNTIME_RELOADS_ENV]: String(reloads) }
}

/** The consecutive-reload count one process carries: inherited from the exec
 * env at startup, reset to zero by a gate pass that found nothing stale, and
 * read by the next reload request to number its replacement. One object per
 * process, shared by the gate and the reload path. */
export type RuntimeReloadLineage = { consecutiveReloads: number }

export function runtimeReloadLineage(env: NodeJS.ProcessEnv): RuntimeReloadLineage {
  return { consecutiveReloads: consecutiveRuntimeReloads(env) }
}

/** Close every process-owned resource before replacing the habitant image.
 * Successful execve never returns and preserves the OS pid. */
export async function execYrdProcessInPlace(
  input: Readonly<{
    closeRuntime(): Promise<void>
    removeShutdownSignals(): void
    closeLog(): void
    execPath: string
    argv: readonly string[]
    env: NodeJS.ProcessEnv
    execve: YrdProcessExecve
  }>,
): Promise<never> {
  await input.closeRuntime()
  input.removeShutdownSignals()
  input.closeLog()
  try {
    return input.execve(input.execPath, input.argv, input.env)
  } catch (error) {
    throw createFailure(
      {
        kind: "infrastructure",
        code: "runtime-reload-exec-failed",
        message: `yrd: habitant runtime reload failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      error,
    )
  }
}
