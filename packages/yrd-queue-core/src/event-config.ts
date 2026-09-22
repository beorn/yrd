/** The event runner slice admitted by #25040; richer evidence is designed in #25065. */
import type { CheckSpec } from "./check.ts"
import type { Notifier } from "./config.ts"

const FOLLOW_ON = "@i/10-yrd/25065-event-queues-run-every-check-kind-beyond-plain-merge-checks"

type EventQueueConfig = Readonly<{
  checks: readonly CheckSpec[]
  setup?: string
  teardown?: string
  notify?: readonly Notifier[]
}>

export type EventQueueConfigAction = "create" | "run" | "submit"

function unsupported(action: EventQueueConfigAction, feature: string, detail = ""): never {
  throw new Error(
    `cannot ${action} an event queue with ${feature}${detail}: #25040 admits plain default merge checks only; ${FOLLOW_ON} owns this event representation before #25041`,
  )
}

/** Refuse every declaration feature whose evidence has no approved event representation yet. */
export function assertPlainEventQueueConfig(config: EventQueueConfig, action: EventQueueConfigAction): void {
  if (config.setup !== undefined) unsupported(action, "setup:")
  if (config.teardown !== undefined) unsupported(action, "teardown:")
  if ((config.notify?.length ?? 0) > 0) {
    unsupported(action, "notify:", ` (${config.notify?.map((entry) => entry.name).join(", ")})`)
  }
  for (const check of config.checks) {
    if (check.on?.includes("submit") === true) unsupported(action, "a submit-phase check", ` (${check.name})`)
    if (check.programRoot === true) unsupported(action, "a programRoot check", ` (${check.name})`)
    if ((check.scripts?.length ?? 0) > 0) unsupported(action, "a scripts check", ` (${check.name})`)
    if (check.long !== undefined) unsupported(action, "a deferred-capable check", ` (${check.name} has long:)`)
  }
}

/** A service stop window can defer a check sequence, which #25040's event vocabulary cannot store. */
export function assertPlainEventQueueRun(
  config: EventQueueConfig,
  options: Readonly<{ tier?: string; stopAtMs?: number }>,
): void {
  assertPlainEventQueueConfig(config, "run")
  if (config.checks.length > 0 && options.tier === "long") unsupported("run", "the long check tier")
  if (config.checks.length > 0 && options.stopAtMs !== undefined) {
    unsupported("run", "a deferred-capable stop window")
  }
}
