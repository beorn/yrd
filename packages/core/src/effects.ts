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

export type EffectError = {
  code: string
  message: string
}

export type EffectOutcome<Output> =
  | { status: "passed"; output: Output }
  | { status: "failed"; error: EffectError }
  | { status: "waiting"; token: string; url?: string; detail?: string; artifacts?: readonly unknown[] }

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
  output?: unknown
  error?: EffectError
  lostReason?: string
}

export type EffectsState = {
  runs: Record<string, EffectRun>
}

type StartArgs = { id: string; executor: string; leaseExpiresAt: string }
type WaitArgs = {
  id: string
  attempt: number
  token: string
  url?: string
  detail?: string
  artifacts?: readonly unknown[]
}
type HeartbeatArgs = { id: string; attempt: number; executor: string; leaseExpiresAt: string }
type FinishArgs = {
  id: string
  attempt: number
  token?: string
  outcome: { status: "passed"; output: unknown } | { status: "failed"; error: EffectError }
}
type LoseArgs = { id: string; attempt: number; reason: string }
type RetryArgs = { id: string }

export type EffectCommands = {
  effect: {
    start: Command<StartArgs, { effects: EffectsState }>
    wait: Command<WaitArgs, { effects: EffectsState }>
    heartbeat: Command<HeartbeatArgs, { effects: EffectsState }>
    finish: Command<FinishArgs, { effects: EffectsState }>
    lose: Command<LoseArgs, { effects: EffectsState }>
    retry: Command<RetryArgs, { effects: EffectsState }>
  }
}

export type EffectExecutor<Input, Output> = (
  input: Input,
  context: { id: string; attempt: number; executor: string },
) => EffectOutcome<Output> | Promise<EffectOutcome<Output>>

export type EffectRuns = {
  register<Input, Output>(
    path: readonly string[],
    effect: Fx<Input, EffectOutcome<Output>>,
    handler?: EffectExecutor<Input, Output>,
  ): void
  run(id: string, options: { executor: string; leaseMs: number; now?: () => number }): Promise<EffectRun>
  recover(options: { now: string; reason?: string }): Promise<string[]>
}

export type HasEffects = {
  initialState: { effects: EffectsState }
  commands: EffectCommands
  effectRuns: EffectRuns
}

type EffectsApp<App extends AnyYrdApp> = ExtendYrdApp<App, { effects: EffectsState }, EffectCommands> & {
  effectRuns: EffectRuns
}

function object(input: unknown, command: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`yrd: ${command}: arguments must be an object`)
  }
  return input as Record<string, unknown>
}

function stringField(input: Record<string, unknown>, field: string, command: string): string {
  const value = input[field]
  if (typeof value !== "string" || value === "") throw new Error(`yrd: ${command}: '${field}' is required`)
  return value
}

function attemptField(input: Record<string, unknown>, command: string): number {
  const value = input.attempt
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`yrd: ${command}: 'attempt' must be a positive integer`)
  }
  return value as number
}

function parseStart(input: unknown): StartArgs {
  const args = object(input, "effect.start")
  return {
    id: stringField(args, "id", "effect.start"),
    executor: stringField(args, "executor", "effect.start"),
    leaseExpiresAt: stringField(args, "leaseExpiresAt", "effect.start"),
  }
}

function parseWait(input: unknown): WaitArgs {
  const args = object(input, "effect.wait")
  const url = args.url
  if (url !== undefined && typeof url !== "string") throw new Error("yrd: effect.wait: 'url' must be a string")
  const detail = args.detail
  if (detail !== undefined && typeof detail !== "string") throw new Error("yrd: effect.wait: 'detail' must be a string")
  const artifacts = args.artifacts
  if (artifacts !== undefined && !Array.isArray(artifacts)) {
    throw new Error("yrd: effect.wait: 'artifacts' must be an array")
  }
  return {
    id: stringField(args, "id", "effect.wait"),
    attempt: attemptField(args, "effect.wait"),
    token: stringField(args, "token", "effect.wait"),
    ...(url === undefined ? {} : { url }),
    ...(detail === undefined ? {} : { detail }),
    ...(artifacts === undefined ? {} : { artifacts }),
  }
}

function parseHeartbeat(input: unknown): HeartbeatArgs {
  const args = object(input, "effect.heartbeat")
  return {
    id: stringField(args, "id", "effect.heartbeat"),
    attempt: attemptField(args, "effect.heartbeat"),
    executor: stringField(args, "executor", "effect.heartbeat"),
    leaseExpiresAt: stringField(args, "leaseExpiresAt", "effect.heartbeat"),
  }
}

function parseFinish(input: unknown): FinishArgs {
  const args = object(input, "effect.finish")
  const outcome = args.outcome
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
    throw new Error("yrd: effect.finish: 'outcome' is required")
  }
  const status = (outcome as { status?: unknown }).status
  if (status !== "passed" && status !== "failed") {
    throw new Error("yrd: effect.finish: outcome status must be passed or failed")
  }
  const token = args.token
  if (token !== undefined && typeof token !== "string") throw new Error("yrd: effect.finish: 'token' must be a string")
  return {
    id: stringField(args, "id", "effect.finish"),
    attempt: attemptField(args, "effect.finish"),
    ...(token === undefined ? {} : { token }),
    outcome: outcome as FinishArgs["outcome"],
  }
}

function parseLose(input: unknown): LoseArgs {
  const args = object(input, "effect.lose")
  return {
    id: stringField(args, "id", "effect.lose"),
    attempt: attemptField(args, "effect.lose"),
    reason: stringField(args, "reason", "effect.lose"),
  }
}

function parseRetry(input: unknown): RetryArgs {
  const args = object(input, "effect.retry")
  return { id: stringField(args, "id", "effect.retry") }
}

function runsOf(state: unknown): EffectsState {
  return (state as { effects: EffectsState }).effects
}

function requireRun(state: unknown, id: string): EffectRun {
  const run = runsOf(state).runs[id]
  if (run === undefined) throw new Error(`yrd: no effect run '${id}'`)
  return run
}

function requireAttempt(run: EffectRun, attempt: number): void {
  if (run.attempt !== attempt) {
    throw new Error(`yrd: effect '${run.id}' attempt ${attempt} is stale; current attempt is ${run.attempt}`)
  }
}

function applyEffectEvent(state: Record<string, unknown>, applied: YrdEvent): Record<string, unknown> {
  const effects = runsOf(state)
  const data = applied.data as Record<string, unknown>
  const id = data.id as string
  if (applied.name === "effect/requested") {
    if (effects.runs[id] !== undefined) throw new Error(`yrd: duplicate effect request '${id}'`)
    return {
      ...state,
      effects: {
        runs: {
          ...effects.runs,
          [id]: {
            id,
            effect: data.effect as string,
            input: data.input,
            ...(data.idempotencyKey === undefined ? {} : { idempotencyKey: data.idempotencyKey as string }),
            status: "requested",
            attempt: 0,
          },
        },
      },
    }
  }
  const current = effects.runs[id]
  if (current === undefined) return state
  let next: EffectRun
  switch (applied.name) {
    case "effect/started":
      next = {
        ...current,
        status: "running",
        attempt: data.attempt as number,
        executor: data.executor as string,
        leaseExpiresAt: data.leaseExpiresAt as string,
        token: undefined,
        url: undefined,
        detail: undefined,
        artifacts: undefined,
        output: undefined,
        error: undefined,
        lostReason: undefined,
      }
      break
    case "effect/waiting":
      next = {
        ...current,
        status: "waiting",
        token: data.token as string,
        ...(data.url === undefined ? {} : { url: data.url as string }),
        ...(data.detail === undefined ? {} : { detail: data.detail as string }),
        ...(data.artifacts === undefined ? {} : { artifacts: data.artifacts as readonly unknown[] }),
      }
      break
    case "effect/heartbeat":
      next = { ...current, leaseExpiresAt: data.leaseExpiresAt as string }
      break
    case "effect/finished": {
      const outcome = data.outcome as FinishArgs["outcome"]
      next = {
        ...current,
        status: outcome.status,
        ...(outcome.status === "passed"
          ? { output: outcome.output, error: undefined }
          : { error: outcome.error, output: undefined }),
      }
      break
    }
    case "effect/lost":
      next = { ...current, status: "lost", lostReason: data.reason as string }
      break
    case "effect/retried":
      next = {
        ...current,
        status: "requested",
        executor: undefined,
        leaseExpiresAt: undefined,
        token: undefined,
        url: undefined,
        detail: undefined,
        artifacts: undefined,
        output: undefined,
        error: undefined,
        lostReason: undefined,
      }
      break
    default:
      return state
  }
  return { ...state, effects: { runs: { ...effects.runs, [id]: next } } }
}

export function withEffects() {
  return <App extends AnyYrdApp>(app: App): EffectsApp<App> => {
    Object.assign(app.initialState, { effects: { runs: {} } })
    const start = op(
      (state: DeepReadonly<{ effects: EffectsState }>, args: StartArgs) => {
        const run = requireRun(state, args.id)
        if (run.status !== "requested") throw new Error(`yrd: effect '${run.id}' is ${run.status}, not requested`)
        return {
          events: [
            event("effect/started", {
              ...args,
              attempt: run.attempt + 1,
            }),
          ],
          effects: [],
        }
      },
      { title: "Start effect", args: { parse: parseStart } },
    )
    const wait = op(
      (state: DeepReadonly<{ effects: EffectsState }>, args: WaitArgs) => {
        const run = requireRun(state, args.id)
        requireAttempt(run, args.attempt)
        if (run.status !== "running") throw new Error(`yrd: effect '${run.id}' is ${run.status}, not running`)
        return { events: [event("effect/waiting", args)], effects: [] }
      },
      { title: "Wait for effect", args: { parse: parseWait } },
    )
    const heartbeat = op(
      (state: DeepReadonly<{ effects: EffectsState }>, args: HeartbeatArgs) => {
        const run = requireRun(state, args.id)
        requireAttempt(run, args.attempt)
        if (run.status !== "running" && run.status !== "waiting") {
          throw new Error(`yrd: effect '${run.id}' is ${run.status}, not running or waiting`)
        }
        if (run.executor !== args.executor) {
          throw new Error(`yrd: effect '${run.id}' executor mismatch`)
        }
        return { events: [event("effect/heartbeat", args)], effects: [] }
      },
      { title: "Renew effect lease", args: { parse: parseHeartbeat } },
    )
    const finish = op(
      (state: DeepReadonly<{ effects: EffectsState }>, args: FinishArgs) => {
        const run = requireRun(state, args.id)
        requireAttempt(run, args.attempt)
        if (run.status !== "running" && run.status !== "waiting") {
          throw new Error(`yrd: effect '${run.id}' is ${run.status}, not running or waiting`)
        }
        if (run.token !== undefined && args.token !== run.token) {
          throw new Error(`yrd: effect '${run.id}' token mismatch`)
        }
        return { events: [event("effect/finished", args)], effects: [] }
      },
      { title: "Finish effect", args: { parse: parseFinish } },
    )
    const lose = op(
      (state: DeepReadonly<{ effects: EffectsState }>, args: LoseArgs) => {
        const run = requireRun(state, args.id)
        requireAttempt(run, args.attempt)
        if (run.status !== "running" && run.status !== "waiting") {
          throw new Error(`yrd: effect '${run.id}' is ${run.status}, not recoverable`)
        }
        return { events: [event("effect/lost", args)], effects: [] }
      },
      { title: "Mark effect lost", args: { parse: parseLose } },
    )
    const retry = op(
      (state: DeepReadonly<{ effects: EffectsState }>, args: RetryArgs) => {
        const run = requireRun(state, args.id)
        if (run.status !== "lost" && run.status !== "failed") {
          throw new Error(`yrd: effect '${run.id}' is ${run.status}, not lost or failed`)
        }
        return { events: [event("effect/retried", args)], effects: [] }
      },
      { title: "Retry effect", args: { parse: parseRetry } },
    )
    Object.assign(app.commands, { effect: { start, wait, heartbeat, finish, lose, retry } })

    const project = app.project
    app.project = (state, applied) => {
      const projected = project(state, applied)
      return applied.name.startsWith("effect/")
        ? applyEffectEvent(projected as Record<string, unknown>, applied)
        : projected
    }

    const handlers = new WeakMap<AnyFx, EffectExecutor<any, any>>()
    const effectRuns: EffectRuns = {
      register(path, ref, handler) {
        app.effectRegistry.register(path, ref)
        handlers.set(ref, handler ?? ref.fn)
      },
      async run(id, options) {
        const before = requireRun(await app.state(), id)
        if (before.status !== "requested") throw new Error(`yrd: effect '${id}' is ${before.status}, not requested`)
        const ref = app.effectRegistry.effectAt(before.effect)
        const handler = ref === undefined ? undefined : handlers.get(ref)
        if (handler === undefined) throw new Error(`yrd: no handler registered for effect '${before.effect}'`)
        const attempt = before.attempt + 1
        const now = options.now?.() ?? Date.now()
        await app.command(start, {
          id,
          executor: options.executor,
          leaseExpiresAt: new Date(now + options.leaseMs).toISOString(),
        })
        let outcome: EffectOutcome<unknown>
        try {
          outcome = await handler(before.input, { id, attempt, executor: options.executor })
        } catch (error) {
          outcome = {
            status: "failed",
            error: { code: "executor-error", message: error instanceof Error ? error.message : String(error) },
          }
        }
        if (outcome.status === "waiting") {
          await app.command(wait, {
            id,
            attempt,
            token: outcome.token,
            ...(outcome.url === undefined ? {} : { url: outcome.url }),
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
            ...(outcome.artifacts === undefined ? {} : { artifacts: outcome.artifacts }),
          })
        } else {
          await app.command(finish, { id, attempt, outcome })
        }
        return requireRun(await app.state(), id)
      },
      async recover(options) {
        const recovered: string[] = []
        const now = Date.parse(options.now)
        if (!Number.isFinite(now)) throw new Error(`yrd: invalid recovery time '${options.now}'`)
        const state = await app.state()
        for (const run of Object.values(runsOf(state).runs)) {
          if (run.status !== "running" && run.status !== "waiting") continue
          if (run.leaseExpiresAt === undefined || Date.parse(run.leaseExpiresAt) > now) continue
          await app.command(lose, {
            id: run.id,
            attempt: run.attempt,
            reason: options.reason ?? "executor lease expired",
          })
          recovered.push(run.id)
        }
        return recovered
      },
    }

    Object.assign(app, { effectRuns })
    return app as unknown as EffectsApp<App>
  }
}
