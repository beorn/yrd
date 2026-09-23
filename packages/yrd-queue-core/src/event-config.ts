/**
 * The event runner slice admitted by #25040; richer evidence is designed in
 * #25065. Creation and CLI entry points audit the complete declaration shape;
 * a library queueRun call receives only the feature refusals below.
 */
import type { CheckSpec } from "./check.ts"
import type { Notifier, QueueConfig } from "./config.ts"

const FOLLOW_ON = "@i/10-yrd/25065-event-queues-run-every-check-kind-beyond-plain-merge-checks"

type EventQueueRunConfig = Readonly<{
  checks: readonly CheckSpec[]
  setup?: string
  teardown?: string
  notify?: readonly Notifier[]
}>

type EventQueueConfigAction = "create" | "run" | "submit"

const QUEUE_KEYS = new Set(["target", "archiveAfter", "checks", "ignore", "blob", "notify", "setup", "teardown"])
const CHECK_KEYS = new Set(["name", "run", "timeoutMs", "environmentPassthrough", "on"])

function unsupported(action: EventQueueConfigAction, feature: string, detail = ""): never {
  throw new Error(
    `cannot ${action} an event queue with ${feature}${detail}: #25040 admits plain default merge checks only; ${FOLLOW_ON} owns this event representation before #25041`,
  )
}

function assertPlainFeatures(config: EventQueueRunConfig, action: EventQueueConfigAction): void {
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
    for (const [key, value] of Object.entries(check)) {
      if (value !== undefined && !CHECK_KEYS.has(key)) unsupported(action, `check key ${key}:`, ` (${check.name})`)
    }
  }
}

/** Refuse every declaration feature or future key the event runner does not execute. */
export function assertPlainEventQueueConfig(config: QueueConfig, action: EventQueueConfigAction): void {
  assertPlainFeatures(config, action)
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && !QUEUE_KEYS.has(key)) unsupported(action, `queue key ${key}:`)
  }
}

/** A service stop window can defer a check sequence, which #25040's event vocabulary cannot store. */
export function assertPlainEventQueueRun(
  config: EventQueueRunConfig,
  options: Readonly<{ tier?: string; stopAtMs?: number }>,
): void {
  assertPlainFeatures(config, "run")
  if (config.checks.length > 0 && options.tier === "long") unsupported("run", "the long check tier")
  if (config.checks.length > 0 && options.stopAtMs !== undefined) {
    unsupported("run", "a deferred-capable stop window")
  }
}
