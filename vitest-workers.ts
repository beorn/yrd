/**
 * The worker cap every yrd Vitest run gets by default.
 *
 * The same policy the root, km and ag configs take from
 * `km-infra/vitest/workers.ts`, restated here because yrd must boot standalone
 * and cannot import across that repository boundary. Kept identical on purpose:
 * `VITEST_MAX_WORKERS` wins when it is a positive integer, otherwise
 * `min(cores - 1, 6)`, never below 1.
 *
 * Why a default at all: an uncapped run on a 32-core host spawned 31 workers,
 * nine Vitest mains were live at once, load reached 59 and every seat on the
 * box slowed, including the live merge queue's own checks (@chief, 2026-09-01
 * 14:01 PDT). A cap that lives in a habit is not a cap.
 */
export const DEFAULT_VITEST_MAX_WORKERS = 6

export type VitestWorkersEnv = Readonly<{ VITEST_MAX_WORKERS?: string }>

export function resolveVitestMaxWorkers(env: VitestWorkersEnv, hostCores: number): number {
  const explicit = Number.parseInt(env.VITEST_MAX_WORKERS ?? "", 10)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return Math.min(Math.max(hostCores - 1, 1), DEFAULT_VITEST_MAX_WORKERS)
}
