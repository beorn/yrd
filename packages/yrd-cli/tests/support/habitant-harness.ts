import type { YrdCliApp, YrdCliIO } from "../../src/types.ts"

export type HabitantWarnCall = Readonly<{ message: string; props: Record<string, unknown> }>

type HabitantState = Readonly<{
  bays: Readonly<{ prs: Readonly<Record<string, unknown>> }>
  jobs?: Readonly<{ byId: Readonly<Record<string, unknown>> }>
  queues: Readonly<{ admissionRefusals: Readonly<Record<string, unknown>> }>
}>

type HabitantRunContext = Readonly<{
  signal: { aborted: boolean }
  call: number
}>

type HabitantHarnessOptions = Readonly<{
  run(context: HabitantRunContext): Promise<readonly unknown[]>
  state?: () => HabitantState
  bays?: Readonly<Record<string, unknown>>
}>

const emptyState = (): HabitantState => ({
  bays: { prs: {} },
  jobs: { byId: {} },
  queues: { admissionRefusals: {} },
})

/** Memoized by INPUT identity: a factory that returns the same object models a
 * durable store with no new observations — an idle cycle — and the completed
 * state must then keep a stable identity across refreshes, exactly as the real
 * app's state does while the journal is not moving. A factory that builds a
 * fresh object per call keeps modeling a moving journal, unchanged. */
const completedStates = new WeakMap<HabitantState, HabitantState>()

function completeState(state: HabitantState) {
  const cached = completedStates.get(state)
  if (cached !== undefined) return cached
  const completed = { ...state, jobs: state.jobs ?? { byId: {} } }
  completedStates.set(state, completed)
  return completed
}

/**
 * One structurally complete habitant-loop test app.
 *
 * `refresh()` snapshots the supplied state factory exactly once per durable
 * refresh, so `state()` keeps stable identity between refreshes just like the
 * real Yrd app. Tests that drive a second habitant cycle model a new durable
 * observation by returning the next snapshot from that factory.
 */
export function createHabitantHarness(options: HabitantHarnessOptions) {
  const signal = { aborted: false }
  const drainController = new AbortController()
  const warnings: HabitantWarnCall[] = []
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
      audit: () => ({ findings: [] }),
      expirePauses: async () => [],
      run: async () => {
        runCalls += 1
        return options.run({ signal, call: runCalls })
      },
      // What a resident publishes in its heartbeat: the plan it built.
      state: () => ({ batchSize: 1 }),
      steps: () => [
        { name: "check", title: "check", revision: "check-v1", kind: "check", classification: "carrier" },
        { name: "merge", title: "merge", revision: "merge-v1", kind: "merge" },
      ],
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

export function createResponseHabitantHarness(runResponses: readonly (() => Promise<readonly unknown[]>)[]) {
  return createHabitantHarness({
    run: ({ call }) => {
      const responder = runResponses[call - 1] ?? runResponses.at(-1)
      if (responder === undefined) throw new Error("no run responder configured")
      return responder()
    },
  })
}
