import { Queues } from "@yrd/queue"
import type { YrdCliState } from "./types.ts"

/** Every durable base a dashboard may ask the process host to resolve. */
export function queueReadBases(state: YrdCliState, configuredBase: string): readonly string[] {
  return [
    ...new Set([
      configuredBase,
      // A standing submit fact carries the base its branch was approved
      // against — since S7 that fact IS the delivery, so it is the same base
      // the deleted change record used to contribute here.
      ...Object.values(state.bays.submits).map((submit) => submit.base),
      ...Queues.values(state.queues).map((run) => run.base),
      ...Object.values(state.queues.pauses).map((pause) => pause.base),
    ]),
  ]
}
