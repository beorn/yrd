/** Event declarations must not admit a key the runner cannot execute. */
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
const CHECK_KEYS = new Set([
  "name",
  "run",
  "timeoutMs",
  "environmentPassthrough",
  "on",
  "long",
  "programRoot",
  "scripts",
])

function unsupported(action: EventQueueConfigAction, feature: string, detail = ""): never {
  throw new Error(
    `cannot ${action} an event queue with ${feature}${detail}: this declaration feature has no event runner executor; ${FOLLOW_ON} keeps it refused before #25041`,
  )
}

function assertPlainFeatures(config: EventQueueRunConfig, action: EventQueueConfigAction): void {
  if (config.teardown !== undefined) unsupported(action, "teardown:")
  for (const check of config.checks) {
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
  void options
}
