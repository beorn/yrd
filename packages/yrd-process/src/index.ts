import { createScope, type Scope } from "@silvery/scope"
import { createFailure } from "@yrd/core"
import { createLogger, type ConditionalLogger } from "loggily"
import { accessSync, constants, statSync, writeSync } from "node:fs"
import { delimiter, isAbsolute, resolve } from "node:path"
import {
  pathReapFailure,
  reapOwnedPath,
  reapOwnedPathWithCensus,
  type PathHolderCensusReader,
  type PathReapResult,
} from "./path-reaper.ts"

export {
  adaptProcessGit,
  cleanGitEnvironment,
  gitFailure,
  gitSuperFailureDetail,
  type GitProcessDefaults,
  type GitSyncReadCommand,
  type GitSyncReadRequest,
  type GitSyncReader,
  type YrdGitProcess,
} from "./git-super.ts"

export {
  certifyPathReapDeletion,
  describeProcessIdentity,
  describeToleratedCensusGap,
  inspectPathHolderCensus,
  inspectPathHolders,
  pathHolderRefusal,
  pathReapDeletionFailure,
  pathReapFailure,
  provablyEmptyGapReason,
  type DarwinPathHolderCoverage,
  type LinuxPathHolderCoverage,
  type UnreadableProcess,
  type PathHolder,
  type PathHolderCensus,
  type PathHolderCensusReader,
  type PathHolderCoverage,
  type PathHolderSourceCoverage,
  type PathHolderUnavailableCoverage,
  type PathReapCertification,
  type PathReapResult,
  type ProvablyEmptyGapReason,
  type ToleratedCensusGap,
} from "./path-reaper.ts"

export type ProcessRequest = Readonly<{
  argv: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string | Uint8Array
  /** Inherit the caller's stdin while keeping stdout/stderr captured. */
  inheritStdin?: boolean
  /** Attach the child directly to the invoking terminal. Interactive runs
   * inherit stdin/stdout/stderr and stay in the foreground process group so
   * editors and agent harnesses receive ordinary terminal input. */
  interactive?: boolean
  /** Exclusive filesystem sandbox owned by this invocation. Settlement enumerates
   * every process whose cwd, executable, or open file remains under this path,
   * then TERM→KILLs and verifies them before run() returns. Use only for
   * an isolation root such as a Yrd Bay, never for a shared repository cwd. */
  ownedPath?: string
  /** Observe the direct child PID synchronously after spawn and before run()
   * awaits output or exit. A thrown observer error terminates and settles the
   * child before the error is propagated. */
  onStart?: (pid: number) => void
  onOutput?: (output: Readonly<{ stream: "stdout" | "stderr"; chunk: Uint8Array }>) => void
  timeoutMs?: number
  /** Explicit inter-output silence lease. It starts with the first observed
   * byte, so queue or scheduler startup latency is not child-stall evidence. */
  noProgressTimeoutMs?: number
  /** Bounded wait for the stdout/stderr pipe to reach EOF AFTER the direct
   * child has EXITED. A descendant outside the direct child's process group can
   * hold the pipe open past the child's death; awaiting that EOF is the queue
   * wedge (run() never returns). An owned-path invocation reaps those processes
   * first; past this grace run() abandons any remaining drain LOUDLY instead of
   * hanging on a pipe only SIGKILL can free. Default:
   * {@link DEFAULT_POST_EXIT_DRAIN_GRACE_MS}. */
  postExitDrainGraceMs?: number
  signal?: AbortSignal
}>

/**
 * One stream's capture overflow. A child's output VOLUME is not a correctness
 * signal, so passing {@link createProcess}'s `maxOutputBytes` truncates the
 * CAPTURE and lets the command run to its real exit status; it never terminates
 * the child and never fails the run. The dropped bytes are reported here AND
 * named in the returned text, because a truncation nobody can see would corrupt
 * every verdict read from that text (docs/principles.md § Fail Loud, Fail Now).
 */
export type OutputTruncation = Readonly<{
  stream: "stdout" | "stderr"
  /** Every byte the child wrote to this stream, including the dropped ones. */
  totalBytes: number
  /** Bytes retained in the returned text, excluding the notice itself. */
  keptBytes: number
  /** Bytes discarded between the retained head and the retained tail. */
  droppedBytes: number
  /** The per-stream capture budget this stream ran past. */
  limitBytes: number
}>

type ProcessResultBase = Readonly<{
  exitCode: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  lastProgressAtMs?: number
  lastProgressBytes?: number
  /**
   * Set, stdout before stderr, when a stream wrote past `maxOutputBytes` and
   * its capture kept only a head and a tail. Loud and never swallowed: the same
   * fact is written into {@link ProcessResultBase.stdout}/`stderr` where a
   * human reading a verdict sees it, and machine consumers read it from here
   * rather than by matching the notice text.
   */
  outputTruncation?: readonly OutputTruncation[]
  /**
   * Set when a settlement signal could not reach the process GROUP (non-ESRCH
   * kill failure) — descendants may survive; loud, never swallowed (21012 S1).
   * Also set when the direct child never reaped after SIGKILL (a D-state or
   * fully escaped tree) so run() had to stop awaiting its exit.
   */
  sweepFailure?: string
  /**
   * Set when the direct child EXITED yet a surviving descendant held the
   * stdout/stderr pipe open past {@link ProcessRequest.postExitDrainGraceMs},
   * so run() abandoned the drain rather than wedge on an EOF only SIGKILL can
   * free. Loud, never swallowed — the queue surfaces it distinctly (the
   * `<step>-stalled-escaped-descendant` blocker) from a plain output stall.
   */
  escapedDescendant?: boolean
}>

export type ProcessResult = ProcessResultBase &
  (
    | Readonly<{ verdict?: "EXITED"; stalled?: false; timedOut: false }>
    | Readonly<{ verdict?: "TIMED_OUT"; stalled?: false; timedOut: true }>
    | Readonly<{
        verdict: "STALLED"
        stalled: true
        timedOut: false
        lastProgressAtMs: number
        lastProgressBytes: number
      }>
  )

/** The command as an operator would retype it, for the message line. `argv`
 * stays whole in the structured payload; this exists so a reader scanning a
 * thousand otherwise-identical process rows can see WHICH command each one is
 * about without parsing JSON. Bounded here and only here — the payload keeps
 * every word. */
/**
 * Whether this command is git — the plumbing whose transcript belongs at TRACE.
 *
 * Read off argv[0]'s own name, so an absolute path to a git binary counts and a
 * check script that merely mentions git does not. Deliberately not a substring
 * match: `git-super` and a repository's own `bin/git-yrd` are OUR commands, and
 * a reader at debug should see them run.
 */
export function isGitInvocation(argv: readonly string[]): boolean {
  const executable = argv[0]
  if (executable === undefined) return false
  const name = executable.slice(executable.lastIndexOf("/") + 1)
  return name === "git"
}

function commandText(argv: readonly string[]): string {
  const text = argv.map((word) => (word === "" || /[\s"'`$\\]/u.test(word) ? JSON.stringify(word) : word)).join(" ")
  return text.length <= 160 ? text : `${text.slice(0, 159)}…`
}

export type Process = Readonly<{
  run(request: ProcessRequest): Promise<ProcessResult>
  /** Reap and verify every process still holding an exclusive filesystem sandbox. */
  reapPath(path: string): Promise<PathReapResult>
  /** Aborts and awaits every active run, including process-group settlement. */
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}>

/** Explicitly opts one process invocation into shell parsing. */
export function shellCommand(script: string): readonly ["sh", "-c", string] {
  if (typeof script !== "string" || script.trim() === "") {
    throw new TypeError("yrd: shell command must be a non-empty string")
  }
  return Object.freeze(["sh", "-c", script])
}

type SpawnOptions = Readonly<
  {
    cwd: string
    env: Record<string, string>
    signal: AbortSignal
    detached: boolean
  } & (
    | Readonly<{ stdin: "ignore" | "inherit" | Blob; stdout: "pipe"; stderr: "pipe" }>
    | Readonly<{ stdin: "inherit"; stdout: "inherit"; stderr: "inherit" }>
  )
>

type Spawned = Readonly<{
  /** Child pid — the process-GROUP id when the spawn established leadership. */
  pid: number
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  exited: Promise<number>
  signalCode: NodeJS.Signals | null
  kill(signal?: number | NodeJS.Signals): void
}>

export type Spawn = (argv: readonly string[], options: SpawnOptions) => Spawned

type StartObserverFailure = Readonly<{ error: unknown }> | undefined

function observeProcessStart(
  observer: ProcessRequest["onStart"],
  pid: number,
  terminate: () => void,
): StartObserverFailure {
  if (observer === undefined) return undefined
  try {
    observer(pid)
    return undefined
  } catch (error) {
    terminate()
    return { error }
  }
}

function propagateStartObserverError(failure: StartObserverFailure): void {
  if (failure !== undefined) throw failure.error
}

/**
 * Default bounded wait for the output pipe to reach EOF after the DIRECT child
 * exits. A child's own buffered bytes are already in the pipe and read in a
 * tight loop the moment it exits, so a stream that stays open is survivor
 * evidence. An invocation with `ownedPath` first reaps every process still
 * holding its isolation root, including descendants that created a new
 * session; this grace remains the loud backstop when no exclusive root was
 * declared or a process escaped every observable ownership fact.
 */
export const DEFAULT_POST_EXIT_DRAIN_GRACE_MS = 2_000

/**
 * Default bound on how long run() awaits the DIRECT child's reap AFTER it has
 * been SIGKILLed. The other way run() can wedge is `child.exited` never
 * resolving — a child stuck in uninterruptible sleep (D-state) or a tree that
 * fully escaped the signal. Generous by design: a real child reaps in
 * microseconds after SIGKILL, so this only fires on a genuinely stuck one, at
 * which point run() returns with a LOUD sweepFailure instead of hanging on a
 * PID exit that is never coming. Deliberately decoupled from `killGraceMs` (the
 * SIGTERM→SIGKILL escalation grace) so a tiny escalation grace cannot make the
 * reap backstop fire on ordinary reap latency.
 */
export const DEFAULT_POST_KILL_REAP_GRACE_MS = 10_000

/**
 * Every process group this process currently leads a pipe-mode child into.
 *
 * WHY A REGISTRY AND NOT JUST `terminate()`. `terminate()` sends SIGTERM at
 * once and escalates to SIGKILL on a TIMER — and a timer dies with the process
 * that armed it. Every ordinary conclusion (park/abort, timeout, stall, close)
 * awaits its own run, so the escalation always gets to fire. An ABANDONED run
 * does not: `executeWithHeartbeat` detaches a run it has given up on
 * (`void execution.catch(...)`) after aborting its scope, so a runner that
 * exits inside the kill grace leaves a TERM-ignoring child alive with nobody
 * left to escalate. It reparents to init and keeps whatever it was doing.
 *
 * That is the 2026-08-18 specimen: `bun tools/manifest-co-change.ts` at 99.5%
 * of a core for 63 minutes under an `sh -c` wrapper owned by PPID 1, found by
 * `/host-health` rather than by the queue, and needing a hand SIGTERM.
 *
 * This is the SAME reaper, not a second one — the group kill `signalTree`
 * already performs — moved onto the one edge that outlives a timer.
 * @see @i/10-yrd/parked-checks-are-reaped
 */
const liveProcessGroups = new Set<number>()
let exitSweepInstalled = false

/**
 * SIGKILL every still-live group as this process leaves. Synchronous by
 * necessity: an `exit` handler cannot await, and the alternative is the leak.
 * A group that already settled answers ESRCH, which is the expected case and
 * the reason the set is not pruned eagerly.
 */
function sweepLiveProcessGroups(): void {
  for (const pgid of liveProcessGroups) {
    try {
      process.kill(-pgid, "SIGKILL")
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === "ESRCH") continue
      // NO SILENT ERRORS. Nothing else can report at this point — the logger's
      // transports may already be torn down — so write the survivor straight to
      // fd 2, naming the pgid so whoever reads the terminal can finish the job.
      writeSync(
        2,
        `yrd: process-group SIGKILL failed for pgid ${String(pgid)} (${code ?? String(error)}) on exit; ` +
          `descendants may survive — inspect and kill manually\n`,
      )
    }
  }
  liveProcessGroups.clear()
}

/** Track one live group for the exit sweep; returns its deregistration. */
function trackProcessGroup(pgid: number): () => void {
  if (!exitSweepInstalled) {
    exitSweepInstalled = true
    // One listener for the whole module, so a long-lived host that runs
    // thousands of commands does not accumulate thousands of handlers.
    process.on("exit", sweepLiveProcessGroups)
  }
  liveProcessGroups.add(pgid)
  return () => liveProcessGroups.delete(pgid)
}

export function createProcess(
  options: Readonly<{
    cwd?: string
    env?: NodeJS.ProcessEnv
    maxOutputBytes?: number
    killGraceMs?: number
    postExitDrainGraceMs?: number
    postKillReapGraceMs?: number
    inject?: Readonly<{
      scope?: Scope
      log?: ConditionalLogger
      now?: () => number
      spawn?: Spawn
      /** Test-only observation seam. Production callers always use the host census. */
      pathHolderCensus?: PathHolderCensusReader
    }>
  }> = {},
): Process {
  const scope = options.inject?.scope?.child("process") ?? createScope("process")
  const log = options.inject?.log?.child("process") ?? createLogger("yrd:process")
  const now = options.inject?.now ?? performance.now.bind(performance)
  const spawn = options.inject?.spawn ?? spawnProcess
  const pathHolderCensus = options.inject?.pathHolderCensus
  const cwd = options.cwd ?? process.cwd()
  const env = definedEnv(options.env ?? process.env)
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 16 * 1024 * 1024, "maxOutputBytes")
  const killGraceMs = positiveInteger(options.killGraceMs ?? 5_000, "killGraceMs")
  const defaultPostExitDrainGraceMs = positiveInteger(
    options.postExitDrainGraceMs ?? DEFAULT_POST_EXIT_DRAIN_GRACE_MS,
    "postExitDrainGraceMs",
  )
  const postKillReapGraceMs = positiveInteger(
    options.postKillReapGraceMs ?? DEFAULT_POST_KILL_REAP_GRACE_MS,
    "postKillReapGraceMs",
  )
  const closingSignal = new AbortController()
  const active = new Set<Promise<void>>()
  let closing = false
  let closePromise: Promise<void> | undefined

  scope.use({
    async [Symbol.asyncDispose]() {
      closing = true
      closingSignal.abort()
      await Promise.allSettled(active)
    },
  })
  const close = () => {
    closing = true
    return (closePromise ??= scope[Symbol.asyncDispose]())
  }
  const reapPath = (path: string) =>
    pathHolderCensus === undefined
      ? reapOwnedPath(path, killGraceMs, postKillReapGraceMs)
      : reapOwnedPathWithCensus(path, killGraceMs, postKillReapGraceMs, pathHolderCensus)
  return {
    async run(request) {
      // Typed like requireSpawnDirectory's spawn-cwd-missing below, for the
      // same reason: a bare Error here is indistinguishable from any other
      // spawn fault, so no caller — least of all the habitant's own
      // mid-cycle recovery classifier — can recognize "the pool is already
      // draining" and stop cleanly instead of crashing uncaught. Close()
      // itself already drains its OWN active set before resolving; this
      // guard exists for whoever calls run() again after that has started,
      // which a shutdown-aware caller must be able to tell apart from a
      // genuine infrastructure fault (2026-08-31 SIGINT teardown race, operator terminal).
      if (closing || scope.disposed) {
        throw createFailure({ kind: "infrastructure", code: "process-closed", message: "yrd: Process is closed" })
      }
      const settled = Promise.withResolvers<void>()
      active.add(settled.promise)
      using _activeRun = {
        [Symbol.dispose]() {
          active.delete(settled.promise)
          settled.resolve()
        },
      }
      const argv = validateArgv(request.argv)
      if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)) {
        throw new RangeError("yrd: Process timeoutMs must be a positive integer")
      }
      if (
        request.noProgressTimeoutMs !== undefined &&
        (!Number.isSafeInteger(request.noProgressTimeoutMs) || request.noProgressTimeoutMs < 1)
      ) {
        throw new RangeError("yrd: Process noProgressTimeoutMs must be a positive integer")
      }
      if (
        request.postExitDrainGraceMs !== undefined &&
        (!Number.isSafeInteger(request.postExitDrainGraceMs) || request.postExitDrainGraceMs < 1)
      ) {
        throw new RangeError("yrd: Process postExitDrainGraceMs must be a positive integer")
      }
      if (request.interactive === true && request.stdin !== undefined) {
        throw new TypeError("yrd: Process interactive runs inherit stdin and cannot provide buffered input")
      }
      if (request.inheritStdin === true && request.stdin !== undefined) {
        throw new TypeError("yrd: Process cannot inherit stdin and provide buffered input")
      }
      if (request.interactive === true && request.inheritStdin === true) {
        throw new TypeError("yrd: Process cannot combine inheritStdin with interactive")
      }
      if (request.interactive === true && request.onOutput !== undefined) {
        throw new TypeError("yrd: Process interactive runs inherit output and cannot capture onOutput")
      }
      if (request.interactive === true && request.noProgressTimeoutMs !== undefined) {
        throw new TypeError("yrd: Process interactive runs cannot measure piped output progress")
      }
      const postExitDrainGraceMs = request.postExitDrainGraceMs ?? defaultPostExitDrainGraceMs
      requireSpawnDirectory(argv, request.cwd ?? cwd)

      // Keep the run scope independent: parent Scope disposal is child-first,
      // which would cancel this run's SIGKILL grace before close can drain it.
      const runScope = createScope(argv[0])
      const signal = AbortSignal.any([
        runScope.signal,
        closingSignal.signal,
        ...(request.signal === undefined ? [] : [request.signal]),
      ])
      const started = now()
      let timedOut = false
      let stalled = false
      let lastProgressAtMs = started
      let lastProgressBytes = 0
      let cancelTimeout: (() => void) | undefined
      let cancelProgressLease: (() => void) | undefined
      let cancelKill: (() => void) | undefined
      let cancelReap: (() => void) | undefined
      let cancelDrainGrace: (() => void) | undefined
      let untrackGroup: (() => void) | undefined
      // GIT CHATTER LIVES AT TRACE (plan of record, M2). One queue run spawns
      // ~200 git commands, and at DEBUG each one printed a finish line AND a
      // span row: 405 of a merging queue run's 537 rows were git transcript,
      // and the six kinds a reader actually wants were 2% of the file
      // (measured 2026-09-02). Both rows are decided HERE, in the one wrapper
      // every command goes through, because a per-call-site rule would be
      // wrong the moment someone adds a call site.
      //
      // `log.trace` is the level probe: loggily leaves a level's method
      // undefined when that level is off, so its presence IS "trace is on".
      const chatter = isGitInvocation(argv)
      using span = chatter && log.trace === undefined ? undefined : log.span?.("run", { argv, cwd: request.cwd ?? cwd })
      try {
        const interactive = request.interactive === true
        const child = spawn(
          argv,
          interactive
            ? {
                cwd: request.cwd ?? cwd,
                env: request.env === undefined ? env : definedEnv(request.env),
                stdin: "inherit",
                stdout: "inherit",
                stderr: "inherit",
                signal,
                detached: false,
              }
            : {
                cwd: request.cwd ?? cwd,
                env: request.env === undefined ? env : definedEnv(request.env),
                stdin:
                  request.inheritStdin === true
                    ? "inherit"
                    : request.stdin === undefined
                      ? "ignore"
                      : inputBlob(request.stdin),
                stdout: "pipe",
                stderr: "pipe",
                signal,
                detached: true,
              },
        )
        // Pipe-mode default children lead a process group so cancellation
        // settles their full tree. Interactive children must remain in the
        // invoking foreground group for terminal job control, so their child
        // harness owns descendant settlement and Yrd signals the direct child.
        const groupSettlement = !interactive && options.inject?.spawn === undefined
        // Registered the moment leadership exists, released in this run's
        // `finally`: between those two points an exit of THIS process would
        // otherwise strand the group. Interactive children are deliberately
        // excluded here for the same reason they are excluded from
        // `signalTree` — they sit in the invoking foreground group, and
        // signalling that group would kill the operator's own shell.
        if (groupSettlement) untrackGroup = trackProcessGroup(child.pid)
        let terminating = false
        let sweepFailure: string | undefined
        // 21012 S1 — settlement owns the FULL process tree. The default spawn
        // makes the child a process-group LEADER (Bun.spawn detached:true —
        // bun's NATIVE spawn honors it; the node:child_process shim does NOT,
        // probed 2026-07-10/11), so signalling -pid reaches every descendant,
        // including a fork worker holding our stdout pipe open (without this,
        // run() hangs PAST its own timeout awaiting a pipe only SIGKILL can
        // free). If leadership is absent (custom injected spawn), -pid names a
        // nonexistent group — the child pid is fresh, never OUR pgid — so the
        // signal degrades to ESRCH and we fall back to the direct child.
        // A self-daemonized descendant can leave this group. Bay-owned runs
        // follow group settlement with the exact path census below, so changing
        // session does not change lifecycle ownership.
        const signalTree = (sig: "SIGTERM" | "SIGKILL"): void => {
          let groupReached = false
          if (groupSettlement) {
            try {
              process.kill(-child.pid, sig)
              groupReached = true
            } catch (error) {
              const code = (error as { code?: string }).code
              // ESRCH: group already fully exited or no leadership — fall back.
              if (code !== "ESRCH") {
                sweepFailure ??= `process-group ${sig} failed (${code ?? String(error)}) — descendants may survive pgid ${child.pid}; inspect and kill manually`
              }
            }
          }
          if (!groupReached) {
            try {
              child.kill(sig)
            } catch (error) {
              const code = (error as { code?: string }).code
              if (code !== "ESRCH") sweepFailure ??= `direct-child ${sig} failed (${code ?? String(error)})`
            }
          }
        }
        // Belt-and-suspenders backstop: `child.exited` never resolving is the
        // OTHER way run() can wedge — a direct child stuck in uninterruptible
        // sleep (D-state) or a tree that fully escaped SIGKILL. Once we have
        // decided to kill it, bound how long we await its reap: after SIGKILL,
        // one more grace, then stop awaiting the PID exit so run() returns with
        // a LOUD sweepFailure instead of hanging on a child that never settles.
        const forcedExit = Promise.withResolvers<number>()
        let childSettled = false
        const terminate = (): void => {
          if (terminating) return
          terminating = true
          signalTree("SIGTERM")
          cancelKill = runScope.timeout(() => {
            signalTree("SIGKILL")
            cancelReap = runScope.timeout(() => {
              if (childSettled) return
              sweepFailure ??= `direct child did not exit within ${postKillReapGraceMs}ms after SIGKILL — may survive pid ${child.pid}; inspect and kill manually`
              forcedExit.resolve(-1)
            }, postKillReapGraceMs)
          }, killGraceMs)
        }
        const onAbort = () => terminate()
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) terminate()
        const startObserverError = observeProcessStart(request.onStart, child.pid, terminate)
        const renewProgressLease = (bytes: number): void => {
          lastProgressAtMs = now()
          lastProgressBytes += bytes
          cancelProgressLease?.()
          if (request.noProgressTimeoutMs !== undefined) {
            cancelProgressLease = runScope.timeout(() => {
              stalled = true
              terminate()
            }, request.noProgressTimeoutMs)
          }
        }
        let outputError: unknown
        // A stream drain we can abandon: aborted when a descendant holds the
        // pipe open past the child's exit so the bounded reads stop waiting for
        // an EOF that is never coming, returning the bytes captured so far.
        const drainAbort = new AbortController()
        const truncations: { stdout?: OutputTruncation; stderr?: OutputTruncation } = {}
        const capture = async (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr"): Promise<string> => {
          try {
            const read = await readBounded(
              stream,
              maxOutputBytes,
              name,
              renewProgressLease,
              request.onOutput,
              drainAbort.signal,
            )
            if (read.truncation !== undefined) {
              // Recorded per stream rather than pushed to a shared array: the
              // two captures race inside Promise.all, and a verdict reader
              // comparing two runs must not see the order flip between them.
              truncations[name] = read.truncation
              log.warn?.(
                `${commandText(argv)} produced more output than Yrd captures; the middle of the stream was dropped.`,
                {
                  argv,
                  ...read.truncation,
                },
              )
            }
            return read.text
          } catch (error) {
            outputError ??= error
            terminate()
            return ""
          }
        }
        if (request.timeoutMs !== undefined) {
          cancelTimeout = runScope.timeout(() => {
            timedOut = true
            terminate()
          }, request.timeoutMs)
        }
        const capturesDone: Promise<readonly [string, string]> =
          child.stdout === null || child.stderr === null
            ? Promise.resolve(["", ""] as const)
            : Promise.all([capture(child.stdout, "stdout"), capture(child.stderr, "stderr")])

        // Bind run()'s completion to the DIRECT child's PID exit — NOT to stream
        // close. A descendant that escaped the group sweep can hold the pipe
        // open indefinitely past the child's death; awaiting that EOF inside
        // Promise.all is the wedge. The reap backstop guarantees this settles.
        const exitCode = await Promise.race([
          child.exited.then((code) => {
            childSettled = true
            return code
          }),
          forcedExit.promise,
        ])

        if (request.ownedPath !== undefined) {
          try {
            const reaped = await reapPath(request.ownedPath)
            const failure = pathReapFailure(reaped)
            if (failure !== undefined) sweepFailure ??= failure
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            sweepFailure ??= `process-tree census failed for ${request.ownedPath}: ${detail}`
          }
        }

        // The command has settled (real exit, or forced after an unkillable
        // child). Bound any residual pipe drain: a still-open stream now means a
        // surviving descendant, so wait a bounded grace for a clean EOF, then
        // abandon the read LOUDLY rather than hang.
        let escapedDescendant = false
        if (childSettled) {
          const drainedCleanly = await new Promise<boolean>((resolve) => {
            cancelDrainGrace = runScope.timeout(() => resolve(false), postExitDrainGraceMs)
            void capturesDone.then(
              () => resolve(true),
              () => resolve(true),
            )
          })
          cancelDrainGrace?.()
          if (!drainedCleanly) {
            escapedDescendant = true
            stalled = true
            log.warn?.(
              `${commandText(argv)} exited, but a child process kept its output open; stopped waiting for more output.`,
              {
                argv,
                pid: child.pid,
                postExitDrainGraceMs,
              },
            )
            // The child is already dead; SIGKILL any remaining in-group holder.
            // An owned-path run already settled out-of-group holders above; the
            // read-end release keeps undeclared/shared-cwd callers bounded too.
            signalTree("SIGKILL")
            drainAbort.abort()
          }
        } else {
          // Forced settle: the child never reaped (sweepFailure already loud);
          // the pipe is held by the live tree, so release our read end.
          log.warn?.(`${commandText(argv)} did not finish after it was killed; stopped waiting for more output.`, {
            argv,
            pid: child.pid,
          })
          drainAbort.abort()
        }
        const [stdout, stderr] = await capturesDone
        signal.removeEventListener("abort", onAbort)
        cancelProgressLease?.()
        cancelDrainGrace?.()
        cancelKill?.()
        cancelReap?.()
        if (outputError !== undefined) throw outputError
        propagateStartObserverError(startObserverError)
        const outputTruncation = [truncations.stdout, truncations.stderr].filter(
          (entry): entry is OutputTruncation => entry !== undefined,
        )
        const result: ProcessResult = {
          exitCode,
          signal: child.signalCode,
          stdout,
          stderr,
          durationMs: Math.max(0, now() - started),
          timedOut,
          stalled,
          verdict: stalled ? "STALLED" : timedOut ? "TIMED_OUT" : "EXITED",
          lastProgressAtMs,
          lastProgressBytes,
          ...(sweepFailure === undefined ? {} : { sweepFailure }),
          ...(escapedDescendant ? { escapedDescendant: true } : {}),
          ...(outputTruncation.length === 0 ? {} : { outputTruncation: Object.freeze(outputTruncation) }),
        } as ProcessResult
        // The check's own commands stay at DEBUG: they are the work, not the
        // plumbing, and a reader at debug wants to see a check run.
        const finished = chatter ? log.trace : log.debug
        finished?.(
          `Command finished ${String(Math.round(result.durationMs))}ms ` +
            `[${result.signal ?? String(result.exitCode)}] ${commandText(argv)}`,
          {
            argv,
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            timedOut,
          },
        )
        if (span !== undefined) {
          Object.assign(span.spanData, {
            // A non-zero exit is command evidence for the caller to classify
            // (many Git probes intentionally use it); only abnormal process
            // settlement is a process-lifecycle failure.
            outcome: result.signal === null && !result.timedOut && !result.stalled ? "succeeded" : "failed",
            durationMs: result.durationMs,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            stalled: result.stalled,
            ...(outputTruncation.length === 0
              ? {}
              : { outputDroppedBytes: outputTruncation.reduce((total, entry) => total + entry.droppedBytes, 0) }),
          })
        }
        return result
      } catch (error) {
        if (span !== undefined) {
          Object.assign(span.spanData, {
            outcome: "failed",
            error: error instanceof Error ? error.message : String(error),
            durationMs: Math.max(0, now() - started),
          })
        }
        throw error
      } finally {
        cancelTimeout?.()
        cancelProgressLease?.()
        cancelDrainGrace?.()
        cancelKill?.()
        cancelReap?.()
        untrackGroup?.()
        await runScope[Symbol.asyncDispose]()
      }
    },
    reapPath,
    close,
    [Symbol.asyncDispose]: close,
  }
}

const ABANDONED = Symbol("drain-abandoned")

type BoundedRead = Readonly<{ text: string; truncation?: OutputTruncation }>

/**
 * A retained head and a retained tail, plus the count of everything dropped
 * between them.
 *
 * The head carries the child's setup and its FIRST failure; the tail carries
 * the summary and the exit, which is where a gate's verdict is written. Both
 * ends matter, so the budget is split evenly rather than spent on whichever
 * arrives first.
 */
class OutputWindow {
  readonly #headLimit: number
  readonly #tailLimit: number
  readonly #head: Uint8Array[] = []
  readonly #tail: Uint8Array[] = []
  #headSize = 0
  #tailSize = 0
  #total = 0
  readonly #limit: number

  constructor(limit: number) {
    this.#limit = limit
    this.#headLimit = Math.max(1, Math.floor(limit / 2))
    this.#tailLimit = limit - this.#headLimit
  }

  admit(chunk: Uint8Array): void {
    this.#total += chunk.byteLength
    let rest = chunk
    if (this.#headSize < this.#headLimit) {
      const take = Math.min(this.#headLimit - this.#headSize, rest.byteLength)
      this.#head.push(rest.subarray(0, take))
      this.#headSize += take
      rest = rest.subarray(take)
    }
    if (rest.byteLength === 0) return
    this.#tail.push(rest)
    this.#tailSize += rest.byteLength
    // Evict from the FRONT of the tail so the retained bytes stay the most
    // recent ones, slicing the oldest surviving chunk rather than dropping it
    // whole — otherwise a single large chunk makes the retained tail an
    // unpredictable multiple of its budget.
    while (this.#tailSize > this.#tailLimit) {
      const oldest = this.#tail[0]
      if (oldest === undefined) break
      const excess = this.#tailSize - this.#tailLimit
      if (oldest.byteLength <= excess) {
        this.#tail.shift()
        this.#tailSize -= oldest.byteLength
      } else {
        this.#tail[0] = oldest.subarray(excess)
        this.#tailSize -= excess
      }
    }
  }

  /**
   * Nothing is dropped until the stream runs PAST the limit, and the eviction
   * above cannot fire before that, so an at-or-under-limit read decodes as one
   * buffer exactly as it did before truncation existed — no seam, no notice,
   * and no multi-byte code point split across the join.
   */
  finish(name: "stdout" | "stderr"): BoundedRead {
    const decoder = new TextDecoder()
    if (this.#total <= this.#limit) {
      return { text: decoder.decode(Buffer.concat([...this.#head, ...this.#tail], this.#total)) }
    }
    const head = withoutPartialTrailingCodePoint(Buffer.concat(this.#head, this.#headSize))
    const tail = withoutPartialLeadingCodePoint(Buffer.concat(this.#tail, this.#tailSize))
    const truncation: OutputTruncation = {
      stream: name,
      totalBytes: this.#total,
      keptBytes: head.byteLength + tail.byteLength,
      // Derived by subtraction from two directly counted numbers, so the notice
      // can never disagree with the bytes actually returned.
      droppedBytes: this.#total - head.byteLength - tail.byteLength,
      limitBytes: this.#limit,
    }
    return {
      text: decoder.decode(head) + truncationNotice(truncation) + decoder.decode(tail),
      truncation,
    }
  }
}

/**
 * The drop notice, in the returned text where a reader of a check verdict
 * cannot miss it. It names what was dropped, how much, why, and where the
 * complete stream still is — a truncation that only a structured field records
 * is a silent one to every human consumer of stdout.
 */
function truncationNotice(truncation: OutputTruncation): string {
  const { stream, droppedBytes, totalBytes, limitBytes, keptBytes } = truncation
  return (
    `\n\n[yrd: ${stream} truncated — ${droppedBytes} bytes dropped here. ` +
    `The command wrote ${totalBytes} bytes, past the ${limitBytes}-byte capture limit, ` +
    `so only ${keptBytes} bytes are kept — a head and a tail — and the middle is gone. ` +
    `Yrd still streamed every byte to this run's output observer; the queue persists that as the step's ` +
    `${stream}.log artifact, which is where the dropped middle can be read.]\n\n`
  )
}

/** UTF-8 continuation bytes match 0b10xxxxxx. */
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

function codePointLength(lead: number): number {
  if (lead >= 0xf0) return 4
  if (lead >= 0xe0) return 3
  if (lead >= 0xc0) return 2
  return 1
}

/**
 * Cut the head back to a whole code point. The drop boundary lands wherever the
 * byte budget ran out, which is regularly mid-character in any output carrying
 * box drawing, arrows or emoji — and a decoder given half a code point emits a
 * replacement character that reads like corrupted program output rather than
 * like a truncation. The few bytes surrendered here are counted as dropped.
 */
function withoutPartialTrailingCodePoint(bytes: Uint8Array): Uint8Array {
  let index = bytes.byteLength - 1
  let continuations = 0
  while (index >= 0 && continuations < 3 && isContinuationByte(bytes[index] as number)) {
    index -= 1
    continuations += 1
  }
  if (index < 0) return bytes
  return codePointLength(bytes[index] as number) === continuations + 1 ? bytes : bytes.subarray(0, index)
}

/** The same cut at the other seam: drop continuation bytes the tail begins with. */
function withoutPartialLeadingCodePoint(bytes: Uint8Array): Uint8Array {
  let index = 0
  while (index < bytes.byteLength && index < 3 && isContinuationByte(bytes[index] as number)) index += 1
  return index === 0 ? bytes : bytes.subarray(index)
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  name: "stdout" | "stderr",
  onProgress: (bytes: number) => void = () => {},
  onOutput: (output: Readonly<{ stream: "stdout" | "stderr"; chunk: Uint8Array }>) => void = () => {},
  abandon?: AbortSignal,
): Promise<BoundedRead> {
  const reader = stream.getReader()
  const window = new OutputWindow(limit)
  // When the caller abandons the drain (a descendant is holding this pipe open
  // past the child's exit), race each read against the abort so the loop stops
  // waiting on an EOF that is never coming; cancel() releases our read end and
  // resolves the pending read, keeping releaseLock() safe.
  const abandoned: Promise<typeof ABANDONED> | undefined =
    abandon === undefined
      ? undefined
      : new Promise((resolve) => {
          if (abandon.aborted) {
            resolve(ABANDONED)
            return
          }
          abandon.addEventListener("abort", () => resolve(ABANDONED), { once: true })
        })
  try {
    while (true) {
      const next = reader.read()
      const outcome = abandoned === undefined ? await next : await Promise.race([next, abandoned])
      if (outcome === ABANDONED) {
        await reader.cancel().catch(() => {})
        return window.finish(name)
      }
      const { done, value } = outcome
      if (done) return window.finish(name)
      window.admit(value)
      // Both observers see EVERY byte, including the ones the window drops.
      //
      // onProgress is the no-progress lease: a flooding child is the single
      // most active kind there is, so withholding its bytes would have the
      // stall detector kill exactly the process this truncation exists to let
      // finish — the same outage in a different costume.
      //
      // onOutput is the caller's own sink, and forwarding in full is what makes
      // the drop notice's promise true: the queue's artifact writer holds the
      // complete stream on disk even when this in-memory capture cannot.
      onProgress(value.byteLength)
      onOutput({ stream: name, chunk: value })
    }
  } finally {
    reader.releaseLock()
  }
}

function spawnProcess(argv: readonly string[], options: SpawnOptions): Spawned {
  // detached:true in pipe mode makes the child a process-GROUP leader, which
  // lets settlement signal the whole tree via -pid. Interactive mode passes
  // detached:false so the child remains attached to terminal job control.
  // Bun's NATIVE spawn honors this; node:child_process does not.
  const [command, ...args] = argv
  if (command === undefined) throw new TypeError("yrd: process argv must contain an executable")
  const executable = resolveExecutable(command, options.env)
  const resolvedArgv = [executable, ...args]
  if (options.stdout === "pipe") return Bun.spawn(resolvedArgv, options)
  const child = Bun.spawn(resolvedArgv, options)
  return {
    pid: child.pid,
    stdout: null,
    stderr: null,
    exited: child.exited,
    get signalCode() {
      return child.signalCode
    },
    kill(signal) {
      child.kill(signal)
    },
  }
}

function resolveExecutable(command: string, env: Readonly<Record<string, string>>): string {
  if (isAbsolute(command) || command.includes("/")) return command
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue
    const candidate = resolve(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // silent-fallback-allow: this is the loop's control flow, not a swallowed
      // failure. accessSync THROWS to say "not executable here", which is the
      // ordinary answer for most PATH entries, and the loop's whole job is to
      // keep looking. A throw would make the first non-match fatal; a log would
      // emit a line per PATH entry per spawn.
      // Keep searching the child environment's PATH.
    }
  }
  return command
}

function definedEnv(input: NodeJS.ProcessEnv | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`yrd: Process ${name} must be a positive integer`)
  return value
}

/**
 * Prove the working directory exists before spawning into it. An absent cwd
 * fails inside posix_spawn with an ENOENT that names neither the directory nor
 * the command — indistinguishable from a missing executable, and untyped, so no
 * caller can classify it and every recovery path treats it as a fatal fault.
 * Yrd derives spawn directories from candidate content (bay, scratch, and
 * reference checkouts, including nested submodule paths a candidate ADDS but
 * the base checkout lacks), so an absent one is an ordinary per-candidate
 * condition that must stay containable instead of killing a long-lived runner.
 */
function requireSpawnDirectory(argv: readonly string[], cwd: string): void {
  const path = resolve(cwd)
  const stats = statSync(path, { throwIfNoEntry: false })
  if (stats?.isDirectory() === true) return
  const command = argv.slice(0, 6).join(" ") + (argv.length > 6 ? " ..." : "")
  throw createFailure({
    kind: "infrastructure",
    code: "spawn-cwd-missing",
    message:
      `yrd: cannot run '${command}' — its working directory '${path}' ` +
      (stats === undefined ? "does not exist" : "is not a directory"),
  })
}

function validateArgv(value: unknown): readonly [string, ...string[]] {
  if (!Array.isArray(value)) throw new TypeError("yrd: Process argv must contain non-empty strings")
  const input = value as readonly unknown[]
  const argv: string[] = []
  for (const arg of input) {
    if (typeof arg !== "string" || arg.length === 0) {
      throw new TypeError("yrd: Process argv must contain non-empty strings")
    }
    argv.push(arg)
  }
  if (argv.length === 0) throw new TypeError("yrd: Process argv must contain non-empty strings")
  return Object.freeze(argv) as readonly [string, ...string[]]
}

function inputBlob(input: string | Uint8Array): globalThis.Blob {
  if (typeof input === "string") return new globalThis.Blob([input])
  const copy = new Uint8Array(input.byteLength)
  copy.set(input)
  return new globalThis.Blob([copy.buffer])
}
