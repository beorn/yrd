import type { YrdCliApp, YrdCliIO } from "../../src/types.ts"

export type HabitantWarnCall = Readonly<{ message: string; props: Record<string, unknown> }>

type HabitantState = Readonly<{
  bays: Readonly<{ prs: Readonly<Record<string, unknown>>; submits?: Readonly<Record<string, unknown>> }>
  jobs?: Readonly<{ byId: Readonly<Record<string, unknown>>; byKey?: Readonly<Record<string, unknown>> }>
  queues: Readonly<{
    admissionRefusals: Readonly<Record<string, unknown>>
    /** The projection lookups the runner's own heartbeat walks. Optional to a
     * TEST AUTHOR, never to the loop -- completeState fills them. */
    records?: Readonly<Record<string, unknown>>
    index?: Readonly<Record<string, unknown>>
    candidates?: Readonly<Record<string, unknown>>
    retiredSubmits?: Readonly<Record<string, unknown>>
  }>
}>

type HabitantRunContext = Readonly<{
  signal: { aborted: boolean }
  call: number
}>

type HabitantHarnessOptions = Readonly<{
  run(context: HabitantRunContext): Promise<readonly unknown[]>
  state?: () => HabitantState
  bays?: Readonly<Record<string, unknown>>
  /** The queue's own audit findings. Every ERROR the resident raises about the
   * QUEUE (rather than about itself) is routed from here, so a test cannot
   * exercise the loud paths without being able to state them. */
  audit?: () => Readonly<{ findings: readonly Record<string, unknown>[] }>
}>

const emptyState = (): HabitantState => ({
  bays: { prs: {} },
  jobs: { byId: {} },
  queues: { admissionRefusals: {} },
})

/**
 * Fill every state slice the habitant loop READS but a test author has no
 * reason to think about. The gap this closes: the runner's own heartbeat calls
 * `habitantDriverLastMerged` -> `queueChanges`, which walks
 * `queues.records` / `queues.index` -- projection lookups `Queues.empty()`
 * always provides in production. A hand-rolled stub omitting them threw INSIDE
 * the heartbeat and the follow loop died before its next cycle. Four habitant
 * suites (level-run, plan-gate, memory, source-recycle) were red at once for
 * that one reason, each reading like the loop regression it exists to catch --
 * so this file's "structurally complete" promise is kept HERE, never
 * re-derived in every fixture.
 */
function completeState(state: HabitantState) {
  return {
    ...state,
    bays: { submits: {}, ...state.bays },
    jobs: { byKey: {}, ...(state.jobs ?? { byId: {} }) },
    queues: { records: {}, index: {}, candidates: {}, retiredSubmits: {}, ...state.queues },
  }
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
  const errors: HabitantWarnCall[] = []
  const debugs: HabitantWarnCall[] = []
  const stderr: string[] = []
  const stdout: string[] = []
  const stateFactory = options.state ?? emptyState
  let lastSnapshot = stateFactory()
  let state = completeState(lastSnapshot)
  let refreshCalls = 0
  let runCalls = 0
  const app = {
    scope: { signal, sleep: async () => undefined },
    state: () => state,
    refresh: async () => {
      refreshCalls += 1
      const snapshot = stateFactory()
      // A factory returning the SAME snapshot models a queue where nothing
      // changed, and the loop reads that identity to decide a cycle is quiet.
      // Minting a fresh object every refresh made every harness cycle look
      // like a durable change, so no test could express a quiet queue — which
      // is exactly the state in which the source-staleness exit was skipped.
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot
        state = completeState(snapshot)
      }
      return state
    },
    log: {
      warn: (message: string, props: Record<string, unknown>) => warnings.push({ message, props }),
      /**
       * The ERROR stream, and its absence here was a hole rather than an
       * omission. `app.log.error?.()` is an OPTIONAL call: with no `error` on
       * this double every one of the resident's six ERROR rows — the queue
       * liveness wedge, the needs-a-person plans, the unappliable remedy — was
       * a silent no-op in every test that used this harness. A runner that
       * stood down loudly and one that died saying nothing produced identical
       * transcripts, so no test could tell them apart, and
       * `habitant-queue-liveness.test.ts` had to hand-roll its own double to
       * assert one line. Loud-versus-silent is exactly the distinction the
       * stand-down conditions turn on, so the harness has to carry it.
       */
      error: (message: string, props: Record<string, unknown>) => errors.push({ message, props }),
      /**
       * The DEBUG stream, a hole of exactly the shape the ERROR one above was.
       * The per-cycle memory observation is a `log.debug?.()` call, so without
       * this the row the resident emits on every tick would be a no-op in
       * every harness test — a runner measuring itself and one measuring
       * nothing would again read identically.
       */
      debug: (message: string, props: Record<string, unknown>) => debugs.push({ message, props }),
    },
    ...(options.bays === undefined ? {} : { bays: options.bays }),
    queue: {
      audit: options.audit ?? (() => ({ findings: [] })),
      expirePauses: async () => [],
      // Every habitant cycle sweeps lapsed leases before deciding anything, so
      // a harness without it cannot drive the loop as a habitant at all.
      recover: async () => [],
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
    /** What the host does when the pass's own ERROR row stops it: the drain
     * signal is aborted with the fatal cause as its reason, and the loop reads
     * that reason to exit `fatal-error` instead of calling the stop clean. */
    stopForError: (cause: Readonly<{ kind: "fatal-error"; namespace: string; message: string }>) =>
      drainController.abort(cause),
    warnings,
    errors,
    debugs,
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
