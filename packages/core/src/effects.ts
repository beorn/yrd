import {
  event,
  op,
  type AnyFx,
  type AnyYrdApp,
  type Command,
  type DeepReadonly,
  type ExtendYrdApp,
  type Fx,
  type YrdEvent,
} from "./app.ts"

export function withEffects() {
  return <App extends AnyYrdApp>(app: App): EffectsApp<App> => {
    Object.assign(app.initialState, { effects: { runs: {} } })

    const transition = op(
      (state: DeepReadonly<{ effects: EffectsState }>, change: EffectTransition) => {
        const next = transitionEffectRun(effectsOf(state).runs[change.id], change)
        return { events: [transitionEvent(change, next)], effects: [] }
      },
      { title: "Transition effect", args: { parse: parseTransition } },
    )
    Object.assign(app.commands, { effect: { transition } })

    const project = app.project
    app.project = (state, applied) => projectEffectEvent(project(state, applied) as Record<string, unknown>, applied)

    const effectRuns = createEffectRuns(app, transition)
    Object.assign(app, { effectRuns })
    return app as unknown as EffectsApp<App>
  }
}

export type EffectError = {
  code: string
  message: string
}

export type EffectOutcome<Output> =
  | { status: "passed"; output: Output }
  | { status: "failed"; error: EffectError; output?: unknown }
  | {
      status: "waiting"
      token: string
      url?: string
      detail?: string
      artifacts?: readonly unknown[]
      checkpoint?: unknown
    }

export type EffectRun = {
  id: string
  effect: string
  input: unknown
  idempotencyKey?: string
  status: "requested" | "running" | "waiting" | "passed" | "failed" | "lost"
  attempt: number
  executor?: string
  leaseExpiresAt?: string
  token?: string
  url?: string
  detail?: string
  artifacts?: readonly unknown[]
  checkpoint?: unknown
  output?: unknown
  error?: EffectError
  lostReason?: string
}

export type EffectsState = {
  runs: Record<string, EffectRun>
}

export type EffectExecutor<Input, Output> = (
  input: Input,
  context: EffectContext,
) => EffectOutcome<Output> | Promise<EffectOutcome<Output>>

export type EffectRunOptions = {
  executor: string
  leaseMs: number
  heartbeatMs?: number
  now?: () => number
}

export type EffectRuns = {
  register<Input, Output>(
    path: readonly string[],
    effect: Fx<Input, EffectOutcome<Output>>,
    handler?: EffectExecutor<Input, Output>,
  ): void
  run(id: string, options: EffectRunOptions): Promise<EffectRun>
  recover(options: { now: string; reason?: string }): Promise<string[]>
}

export type EffectCommands = {
  effect: {
    transition: Command<EffectTransition, { effects: EffectsState }>
  }
}

export type HasEffects = {
  initialState: { effects: EffectsState }
  commands: EffectCommands
  effectRuns: EffectRuns
}

type EffectsApp<App extends AnyYrdApp> = ExtendYrdApp<App, { effects: EffectsState }, EffectCommands> & {
  effectRuns: EffectRuns
}

type EffectContext = { id: string; attempt: number; executor: string }
type WaitingOutcome = Extract<EffectOutcome<unknown>, { status: "waiting" }>
type TerminalOutcome = Exclude<EffectOutcome<unknown>, WaitingOutcome>
type EffectTransition =
  | { type: "start"; id: string; executor: string; leaseExpiresAt: string; attempt?: number }
  | ({ type: "wait"; id: string; attempt: number } & Omit<WaitingOutcome, "status">)
  | { type: "heartbeat"; id: string; attempt: number; executor: string; leaseExpiresAt: string }
  | { type: "finish"; id: string; attempt: number; token?: string; outcome: TerminalOutcome }
  | { type: "lose"; id: string; attempt: number; reason: string }
  | { type: "retry"; id: string }
type EffectAction =
  | EffectTransition
  | { type: "request"; id: string; effect: string; input: unknown; idempotencyKey?: string }

function transitionEffectRun(current: EffectRun | undefined, change: EffectAction): EffectRun {
  if (change.type === "request") {
    if (current !== undefined) throw new Error(`yrd: duplicate effect request '${change.id}'`)
    return {
      id: change.id,
      effect: change.effect,
      input: change.input,
      ...(change.idempotencyKey === undefined ? {} : { idempotencyKey: change.idempotencyKey }),
      status: "requested",
      attempt: 0,
    }
  }

  if (current === undefined) throw new Error(`yrd: no effect run '${change.id}'`)

  switch (change.type) {
    case "start": {
      requireStatus(current, "requested", "requested")
      const attempt = change.attempt ?? current.attempt + 1
      if (attempt !== current.attempt + 1) {
        throw new Error(`yrd: effect '${current.id}' started attempt ${attempt} after attempt ${current.attempt}`)
      }
      return {
        ...resetExecution(current),
        status: "running",
        attempt,
        executor: change.executor,
        leaseExpiresAt: change.leaseExpiresAt,
      }
    }
    case "wait":
      requireAttempt(current, change.attempt)
      requireStatus(current, "running", "running")
      return {
        ...current,
        status: "waiting",
        token: change.token,
        url: change.url,
        detail: change.detail,
        artifacts: change.artifacts,
        checkpoint: change.checkpoint,
      }
    case "heartbeat":
      requireAttempt(current, change.attempt)
      requireStatus(current, "running or waiting", "running", "waiting")
      if (current.executor !== change.executor) throw new Error(`yrd: effect '${current.id}' executor mismatch`)
      return { ...current, leaseExpiresAt: change.leaseExpiresAt }
    case "finish": {
      requireAttempt(current, change.attempt)
      requireStatus(current, "running or waiting", "running", "waiting")
      if (current.token !== undefined && change.token !== current.token) {
        throw new Error(`yrd: effect '${current.id}' token mismatch`)
      }
      return { ...current, ...change.outcome }
    }
    case "lose":
      requireAttempt(current, change.attempt)
      requireStatus(current, "recoverable", "running", "waiting")
      return { ...current, status: "lost", lostReason: change.reason }
    case "retry":
      requireStatus(current, "lost or failed", "lost", "failed")
      return resetExecution(current)
  }
}

const EFFECT_EVENTS = {
  request: "effect/requested",
  start: "effect/started",
  wait: "effect/waiting",
  heartbeat: "effect/heartbeat",
  finish: "effect/finished",
  lose: "effect/lost",
  retry: "effect/retried",
} as const

const EFFECT_ACTION_BY_EVENT = Object.freeze(
  Object.fromEntries(Object.entries(EFFECT_EVENTS).map(([type, name]) => [name, type])),
) as Readonly<Record<string, EffectAction["type"]>>

function transitionEvent(change: EffectTransition, next: EffectRun) {
  const recorded = change.type === "start" ? { ...change, attempt: next.attempt } : change
  const { type, ...data } = recorded
  return event(EFFECT_EVENTS[type], data)
}

function projectEffectEvent(state: Record<string, unknown>, applied: YrdEvent): Record<string, unknown> {
  const type = EFFECT_ACTION_BY_EVENT[applied.name]
  if (type === undefined) return state
  const change = { ...(applied.data as object), type } as EffectAction
  const effects = effectsOf(state)
  const next = transitionEffectRun(effects.runs[change.id], change)
  return { ...state, effects: { runs: { ...effects.runs, [change.id]: next } } }
}

function createEffectRuns(
  app: AnyYrdApp,
  transition: Command<EffectTransition, { effects: EffectsState }>,
): EffectRuns {
  const handlers = new WeakMap<AnyFx, RegisteredExecutor>()
  const commit = (change: EffectTransition) => app.command(transition, change)

  return {
    register<Input, Output>(
      path: readonly string[],
      ref: Fx<Input, EffectOutcome<Output>>,
      handler?: EffectExecutor<Input, Output>,
    ) {
      const execute = handler ?? ref.fn
      app.effectRegistry.register(path, ref)
      handlers.set(ref, (input, context) => execute(input as Input, context))
    },

    async run(id, options) {
      const heartbeatMs = heartbeatInterval(options)
      const requested = requireRun(await app.state(), id)
      if (requested.status !== "requested") {
        throw new Error(`yrd: effect '${id}' is ${requested.status}, not requested`)
      }
      const ref = app.effectRegistry.effectAt(requested.effect)
      const handler = ref === undefined ? undefined : handlers.get(ref)
      if (handler === undefined) throw new Error(`yrd: no handler registered for effect '${requested.effect}'`)

      await commit({
        type: "start",
        id,
        executor: options.executor,
        leaseExpiresAt: lease(options),
      })
      const attempt = requireRun(await app.state(), id).attempt
      const execution = await executeWithHeartbeat(
        () => handler(requested.input, { id, attempt, executor: options.executor }),
        heartbeatMs,
        async () => {
          const current = requireRun(await app.state(), id)
          if (current.status !== "running") return
          await commit({
            type: "heartbeat",
            id,
            attempt,
            executor: options.executor,
            leaseExpiresAt: lease(options),
          })
        },
      )

      const current = requireRun(await app.state(), id)
      if (current.status !== "running") return current
      const outcome =
        execution.heartbeatFailure === undefined
          ? execution.outcome
          : failedOutcome("heartbeat-failed", execution.heartbeatFailure)
      await commit(settlement(id, attempt, outcome))
      return requireRun(await app.state(), id)
    },

    async recover(options) {
      const now = Date.parse(options.now)
      if (!Number.isFinite(now)) throw new Error(`yrd: invalid recovery time '${options.now}'`)
      const recovered: string[] = []
      for (const run of Object.values(effectsOf(await app.state()).runs)) {
        if (run.status !== "running" && run.status !== "waiting") continue
        if (run.leaseExpiresAt === undefined || Date.parse(run.leaseExpiresAt) > now) continue
        await commit({
          type: "lose",
          id: run.id,
          attempt: run.attempt,
          reason: options.reason ?? "executor lease expired",
        })
        recovered.push(run.id)
      }
      return recovered
    },
  }
}

type RegisteredExecutor = (
  input: unknown,
  context: EffectContext,
) => EffectOutcome<unknown> | Promise<EffectOutcome<unknown>>

async function executeWithHeartbeat(
  execute: () => EffectOutcome<unknown> | Promise<EffectOutcome<unknown>>,
  heartbeatMs: number,
  heartbeat: () => Promise<void>,
): Promise<{ outcome: EffectOutcome<unknown>; heartbeatFailure?: unknown }> {
  let heartbeatFailure: { error: unknown } | undefined
  let heartbeatChain = Promise.resolve()
  const timer = setInterval(() => {
    heartbeatChain = heartbeatChain.then(async () => {
      if (heartbeatFailure !== undefined) return undefined
      try {
        await heartbeat()
      } catch (error) {
        heartbeatFailure = { error }
      }
      return undefined
    })
  }, heartbeatMs)

  let outcome: EffectOutcome<unknown>
  try {
    outcome = await execute()
  } catch (error) {
    outcome = failedOutcome("executor-error", error)
  } finally {
    clearInterval(timer)
    await heartbeatChain
  }
  return {
    outcome,
    ...(heartbeatFailure === undefined ? {} : { heartbeatFailure: heartbeatFailure.error }),
  }
}

function settlement(id: string, attempt: number, outcome: EffectOutcome<unknown>): EffectTransition {
  if (outcome.status === "waiting") {
    const { status: _status, ...waiting } = outcome
    return { type: "wait", id, attempt, ...defined(waiting) }
  }
  return { type: "finish", id, attempt, outcome: defined(outcome) }
}

function heartbeatInterval(options: EffectRunOptions): number {
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 2) {
    throw new Error("yrd: effect leaseMs must be an integer of at least 2ms")
  }
  const heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(options.leaseMs / 3))
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= options.leaseMs) {
    throw new Error("yrd: effect heartbeatMs must be a positive integer smaller than leaseMs")
  }
  return heartbeatMs
}

function lease(options: EffectRunOptions): string {
  return new Date((options.now?.() ?? Date.now()) + options.leaseMs).toISOString()
}

function failedOutcome(code: string, error: unknown): EffectOutcome<never> {
  return {
    status: "failed",
    error: { code, message: error instanceof Error ? error.message : String(error) },
  }
}

function resetExecution(run: EffectRun): EffectRun {
  const { id, effect, input, idempotencyKey, attempt } = run
  return {
    id,
    effect,
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    status: "requested",
    attempt,
  }
}

function defined<Value extends object>(value: Value): Value {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as Value
}

function effectsOf(state: unknown): EffectsState {
  return (state as { effects: EffectsState }).effects
}

function requireRun(state: unknown, id: string): EffectRun {
  const run = effectsOf(state).runs[id]
  if (run === undefined) throw new Error(`yrd: no effect run '${id}'`)
  return run
}

function requireAttempt(run: EffectRun, attempt: number): void {
  if (run.attempt !== attempt) {
    throw new Error(`yrd: effect '${run.id}' attempt ${attempt} is stale; current attempt is ${run.attempt}`)
  }
}

function requireStatus(run: EffectRun, expected: string, ...allowed: EffectRun["status"][]): void {
  if (!allowed.includes(run.status)) throw new Error(`yrd: effect '${run.id}' is ${run.status}, not ${expected}`)
}

const TRANSITION_TYPES = ["start", "wait", "heartbeat", "finish", "lose", "retry"] as const

function parseTransition(input: unknown): EffectTransition {
  const change = record(input)
  const type = change.type as EffectTransition["type"]
  if (!TRANSITION_TYPES.includes(type)) {
    throw new Error("yrd: effect.transition: invalid transition type")
  }
  requiredStrings(change, "id")
  switch (type) {
    case "start":
      requiredStrings(change, "executor", "leaseExpiresAt")
      break
    case "wait":
      requireAttemptField(change)
      requiredStrings(change, "token")
      optionalStrings(change, "url", "detail")
      if (change.artifacts !== undefined && !Array.isArray(change.artifacts)) {
        throw new Error("yrd: effect.transition: 'artifacts' must be an array")
      }
      break
    case "heartbeat":
      requireAttemptField(change)
      requiredStrings(change, "executor", "leaseExpiresAt")
      break
    case "finish":
      requireAttemptField(change)
      optionalStrings(change, "token")
      validateOutcome(change.outcome)
      break
    case "lose":
      requireAttemptField(change)
      requiredStrings(change, "reason")
      break
    case "retry":
      break
  }
  return change as unknown as EffectTransition
}

function validateOutcome(value: unknown): void {
  const outcome = record(value, "outcome")
  if (outcome.status === "passed") return
  if (outcome.status !== "failed") {
    throw new Error("yrd: effect.transition: outcome status must be passed or failed")
  }
  requiredStrings(record(outcome.error, "outcome error"), "code", "message")
}

function record(input: unknown, subject = "arguments"): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`yrd: effect.transition: ${subject} must be an object`)
  }
  return input as Record<string, unknown>
}

function requireAttemptField(input: Record<string, unknown>): void {
  const value = input.attempt
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("yrd: effect.transition: 'attempt' must be a positive integer")
  }
}

function requiredStrings(input: Record<string, unknown>, ...fields: string[]): void {
  for (const field of fields) {
    if (typeof input[field] !== "string" || input[field] === "") {
      throw new Error(`yrd: effect.transition: '${field}' is required`)
    }
  }
}

function optionalStrings(input: Record<string, unknown>, ...fields: string[]): void {
  for (const field of fields) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      throw new Error(`yrd: effect.transition: '${field}' must be a string`)
    }
  }
}
