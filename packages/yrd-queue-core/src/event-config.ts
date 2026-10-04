/** Event declarations must not admit a key the runner cannot execute. */
import type { CheckSpec } from "./check.ts"
import type { Notifier, QueueConfig } from "./config.ts"

type EventQueueRunConfig = Readonly<{
  checks: readonly CheckSpec[]
  setup?: string
  teardown?: string
  notify?: readonly Notifier[]
}>

type EventQueueConfigAction = "create" | "run" | "submit"

/** Every parsed queue field needs an explicit event-runner decision. */
const QUEUE_KEYS = {
  target: "supported",
  archiveAfter: "supported",
  checks: "supported",
  health: "supported",
  ignore: "supported",
  issueResolver: "supported",
  admission: "supported",
  blob: "supported",
  notify: "supported",
  revertGuard: "supported",
  setup: "supported",
  derive: "supported",
  teardown: "refused",
} as const satisfies Record<keyof QueueConfig, "supported" | "refused">
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
  const cleanFeature = feature.replace(/:$/, "")
  const subject = detail.length > 0 ? `${feature}${detail}:` : feature
  throw new Error(
    `cannot ${action} an event queue with ${subject} this declaration feature has no event runner executor; remove ${cleanFeature} from .yrd.yml to run on an event queue`,
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
    if (value !== undefined && QUEUE_KEYS[key as keyof QueueConfig] !== "supported") {
      unsupported(action, `queue key ${key}:`)
    }
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
