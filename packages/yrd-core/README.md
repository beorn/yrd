# `@yrd/core`

M6 (2026-09-03) deleted the immutable-definition/Journal engine this package
used to house. Six small utilities remain, each still imported elsewhere:

- `failure.ts` — the shared `FailureFact` contract: `createFailure`,
  `raiseFailure`, `markRecoverable`, `isRecoverableFailure`.
- `clock.ts` — `systemClock`, the one wall-clock reader `now`/`clock` options default to.
- `duration.ts` — human duration formatting shared by CLI narration and lifecycle logs.
- `observability.ts` — `observeYrdLifecycle` and the lifecycle-outcome vocabulary.
- `stage-clock.ts` — `stage`/`stageAsync`/`stageReport` elapsed-time stage instrumentation.
- `stage-spans.ts` — `withStageAccounting`, span accounting built on `stage-clock.ts`.
