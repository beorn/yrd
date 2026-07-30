import { Queues } from "@yrd/queue"
import type { VersionedQueueReadModel } from "./queue-read-model.ts"
import type { YrdCliServices, YrdCliState } from "./types.ts"

/**
 * Process-host facts for read-only queue commands. The symbol deliberately
 * stays out of {@link YrdCliServices}: this is a private host/CLI seam, not a
 * plugin API or a second runtime.
 */
export const QueueReadBoundary = Symbol("yrd.queue-read-boundary")

export type QueueReadBoundaryFacts = Readonly<{
  readModel?: Pick<VersionedQueueReadModel, "snapshot">
}>

type InternalServices = YrdCliServices &
  Readonly<{
    [QueueReadBoundary]?: QueueReadBoundaryFacts
  }>

export function queueReadBoundary(services: YrdCliServices): QueueReadBoundaryFacts | undefined {
  return (services as InternalServices)[QueueReadBoundary]
}

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
