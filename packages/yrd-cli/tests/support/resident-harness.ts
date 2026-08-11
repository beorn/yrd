import type { YrdCliApp, YrdCliIO } from "../../src/types.ts"

export type ResidentWarnCall = Readonly<{ message: string; props: Record<string, unknown> }>

type ResidentState = Readonly<{
  bays: Readonly<{ prs: Readonly<Record<string, unknown>> }>
  jobs?: Readonly<{ byId: Readonly<Record<string, unknown>> }>
  queues: Readonly<{ admissionRefusals: Readonly<Record<string, unknown>> }>
}>

type ResidentRunContext = Readonly<{
  signal: { aborted: boolean }
  call: number
}>

type ResidentHarnessOptions = Readonly<{
  run(context: ResidentRunContext): Promise<readonly unknown[]>
  state?: () => ResidentState
  bays?: Readonly<Record<string, unknown>>
}>

const emptyState = (): ResidentState => ({
  bays: { prs: {} },
  jobs: { byId: {} },
  queues: { admissionRefusals: {} },
})

function completeState(state: ResidentState) {
  return { ...state, jobs: state.jobs ?? { byId: {} } }
}

/**
 * One structurally complete resident-loop test app.
 *
 * `refresh()` snapshots the supplied state factory exactly once per durable
 * refresh, so `state()` keeps stable identity between refreshes just like the
 * real Yrd app. Tests that drive a second resident cycle model a new durable
 * observation by returning the next snapshot from that factory.
 */
export function createResidentHarness(options: ResidentHarnessOptions) {
  const signal = { aborted: false }
  const drainController = new AbortController()
  const warnings: ResidentWarnCall[] = []
  const stderr: string[] = []
  const stdout: string[] = []
  const stateFactory = options.state ?? emptyState
  let state = completeState(stateFactory())
  let refreshCalls = 0
  let runCalls = 0
  const app = {
    scope: { signal, sleep: async () => undefined },
    state: () => state,
    refresh: async () => {
      refreshCalls += 1
      state = completeState(stateFactory())
      return state
    },
    log: {
      warn: (message: string, props: Record<string, unknown>) => warnings.push({ message, props }),
    },
    ...(options.bays === undefined ? {} : { bays: options.bays }),
    queue: {
      run: async () => {
        runCalls += 1
        return options.run({ signal, call: runCalls })
      },
    },
  } as unknown as YrdCliApp
  const io = {
    drainSignal: drainController.signal,
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
  } as unknown as YrdCliIO
  const gate = async (): Promise<void> => undefined
  return {
    app,
    io,
    gate,
    signal,
    drain: () => drainController.abort(),
    warnings,
    stderr,
    stdout,
    refreshCalls: () => refreshCalls,
    runCalls: () => runCalls,
  }
}

export function createResponseResidentHarness(runResponses: readonly (() => Promise<readonly unknown[]>)[]) {
  return createResidentHarness({
    run: ({ call }) => {
      const responder = runResponses[call - 1] ?? runResponses.at(-1)
      if (responder === undefined) throw new Error("no run responder configured")
      return responder()
    },
  })
}
