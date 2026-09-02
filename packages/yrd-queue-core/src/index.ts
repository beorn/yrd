/**
 * The queue's core: one store, which is the git repository.
 *
 * A branch is its ref at the queue's remote; a change is the ref
 * `refs/yrd/changes/<branch>/<sha>`, whose commits are its facts; a landing is
 * the merge commit on the target. Nothing else is written and nothing is
 * remembered: every state a reader sees is derived from those refs and the
 * target's ancestry at the moment they ask.
 *
 * This package is the replacement core of the [plan](../../../../pm/@i/10-yrd/plan.md)
 * § Milestones M4. It reuses the git wrapper, submodule materialization, the
 * check driver and the notifier unchanged, and the incumbent `queue.ts` is
 * untouched until the flag day at M5 retires it whole.
 */

export { CHANGES, SUBMITS, changeRef, parseChangeRef, parseSubmitRef, submitRef } from "./refs.ts"
export { FACT_KINDS, appendFact, factMessage, readFacts, trailer, trailers } from "./facts.ts"
export type { Fact, FactKind, Git, WriteFact } from "./facts.ts"
export { CHANGE_STATES, inLine, readChange } from "./state.ts"
export type { ChangeFacts, ChangeReading, ChangeState } from "./state.ts"
export { GitExit, gitIn, isAncestor, refAt } from "./git.ts"
export { DEFAULT_CHECK_BOUND_MS, runCheck } from "./check.ts"
export type { CheckResult, CheckSpec, RunCheck } from "./check.ts"
export { lane } from "./remote.ts"
export type { LaneEntry } from "./remote.ts"
export { submit } from "./submit.ts"
export type { SubmitRequest, Submitted } from "./submit.ts"
