/**
 * The liveness contract lives beside the lease it reads (`@yrd/job`,
 * `run-liveness.ts`): the Job package holds the lease and is the settlement
 * writer (`jobs.recover`), so the one derivation must be reachable from there.
 * This module forwards it so every `@yrd/queue` reader keeps its import path;
 * it computes nothing.
 */
export { deriveRunLiveness, describeOrphanedRun, runnerPid } from "@yrd/job"
export type { RunLiveness, RunnerLivenessProbe, RunningJobIdentity } from "@yrd/job"
