import { Queues } from "@yrd/queue"
import type { YrdCliState } from "./types.ts"

/** Every durable base a dashboard may ask the process host to resolve. */
export function queueReadBases(state: YrdCliState, configuredBase: string): readonly string[] {
  return [
    ...new Set([
      configuredBase,
      ...Object.values(state.bays.prs).map((pr) => pr.base),
      ...Queues.values(state.queues).map((run) => run.base),
      ...Object.values(state.queues.pauses).map((pause) => pause.base),
    ]),
  ]
}
