/**
 * The resident reader's own progress frame (#38182 row 1, @cto 77dd37ea).
 *
 * `list-page-serve` hands a declared provider this process's stdio, so a reader that stays up pays no process start per
 * read. The one thing it could not answer was Yrd's own sparse progress frame: that came from a second child per
 * refresh (a `km`/`journal writes` process opening a 20 GB store, ~1.5 s on /hh/pm). Here the ONE provider connection
 * also carries journal lines: the reader asks the provider for the vault's journal after the change number it applied,
 * folds the new lines into the activity state it has held since start, and answers the frame itself.
 *
 * Frames stay the provider's, one JSON object per line (`km bd page-serve` documents them):
 *
 *   client   {"seq": 7, "request": {binding, population, generation, limit, page?, changedSince?, traverse?, progress?}}
 *   provider {"seq": 7, "page": {…}}                    one line per page; a traversal ends on `complete: true`
 *   provider {"seq": 7, "refusal": {code, message, hint?}}
 *
 * `progress: true` inside the caller's request is Yrd's own flag (the CLI strips it before the provider sees it), so
 * the reader strips it too: a request naming anything else is forwarded and its pages relayed unchanged, and the frame
 * is attached to the terminal page. A request naming ONLY `progress` reads no native page at all — that is what keeps
 * an empty refresh as cheap as a full store, and it is what replaces the per-refresh child.
 *
 * The reader keeps one journal question of its own on the same connection:
 *
 *   {"seq": "yrd-journal-1", "request": {"journal": {"after": 13751234, "sinceTs"?: <epoch ms>, "limit"?: 5000}}}
 *   {"seq": "yrd-journal-1", "journal": {"generation": "<dev>:<ino>", "head": 13752546, "asOf": <ms>, "lines": […], "more": false}}
 *
 * `generation` changes only when the vault REPLACES its store file, so a cursor from another file is never applied: the
 * reader rebuilds in full, once, and says why on stderr. It does the same once at start, and once if the journal shrank.
 *
 * Every progress answer carries `{seq, lagSeq, asOf}` beside the projection's own `{default, source, qualifying,
 * complete}`: the change number it was built from, how far behind the journal that is (`null` when the refresh failed
 * and the reader cannot say), and when the journal answered. A failed refresh keeps the last state and answers
 * `source: "unreadable"`, never a stale value passing as current.
 *
 * One request is outstanding at a time (the host's reader enforces that), so the relay needs no seq accounting beyond
 * the frame it is answering: a client frame is fully answered before the next one is read.
 */
import { Readable } from "node:stream"
import { resolveExecutable } from "@yrd/process"
import {
  EMPTY_ACTIVITY,
  OWNER_ACTIVITY_WINDOW_MS,
  activityEventOf,
  applyActivity,
  progressFromActivity,
  type IssuesActivityEvent,
  type IssuesActivityState,
  type IssuesEnvironmentHold,
  type IssuesProgress,
} from "./in-progress.ts"

/** One answer a client can see: what can go wrong here has a name, so a host can show it instead of an exit code. */
export class ProgressServeRefusal extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** The declared provider could not be started at all: the same named failure a one-shot provider gets. */
export class ProgressServeProviderMissing extends Error {
  readonly argv0: string
  constructor(argv0: string, cause: unknown) {
    super(describe(cause), { cause })
    this.argv0 = argv0
  }
}

/** The journal answer, as `km bd page-serve` documents it beside its page kinds. */
type JournalAnswer = Readonly<{
  generation: string
  head: number
  asOf: number
  lines: readonly unknown[]
  more: boolean
}>

/** The frame as a reader hands it out: the projection plus how current it is (@cto 77dd37ea). */
export type ServedProgress = IssuesProgress &
  Readonly<{ seq: number; lagSeq: number | null; asOf: string | null }>

export type ProgressServeOptions = Readonly<{
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** This repository's open environments: the holds half of the frame, read once per answer. */
  readHolds: () => Promise<readonly IssuesEnvironmentHold[]>
  /** Where the reader says what it did: one line per rebuild, and a slow or failed answer's cause. */
  log: (line: string) => void
  /** How stale an owner's write may be; the window the fold prunes with. */
  windowMs?: number
  now?: () => number
  /** This process's own stdio: the client's frames in, the answers out. */
  input?: AsyncIterable<Uint8Array | string>
  output?: { write(text: string): unknown }
}>

export type ProgressServeOutcome = Readonly<{ exitCode: number }>

/** One journal request's batch; the provider's own ceiling is the same number. */
const JOURNAL_LIMIT = 5_000
/** A window that does not fit in this many batches is a broken journal, not a large one. */
const JOURNAL_BATCH_BOUND = 200
/** An answer at or above this cost says why on stderr, so a p95 has a source in the log. */
const SLOW_ANSWER_MS = 50

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One line per chunk boundary, CRLF folded, so a frame split across writes is still one line. */
async function* readLines(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let held = ""
  for await (const chunk of stream) {
    held += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    for (let index = held.indexOf("\n"); index >= 0; index = held.indexOf("\n")) {
      const line = held.slice(0, index)
      held = held.slice(index + 1)
      yield line.endsWith("\r") ? line.slice(0, -1) : line
    }
  }
  held += decoder.decode()
  if (held !== "") yield held.endsWith("\r") ? held.slice(0, -1) : held
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/** The client's frame, as this module needs it: the answer slot and the provider request inside it. */
type ClientFrame = Readonly<{ seq: unknown; request: Record<string, unknown> }>

export async function serveProgressReader(options: ProgressServeOptions): Promise<ProgressServeOutcome> {
  const [executable, ...args] = options.argv
  if (executable === undefined) {
    throw new ProgressServeRefusal("page-serve-no-command", "the declaration's argv is empty")
  }
  const now = options.now ?? Date.now
  const windowMs = options.windowMs ?? OWNER_ACTIVITY_WINDOW_MS
  const env = definedEnv(options.env)
  // The provider's own words are diagnostics, and the client's stderr contract already carries them: inherited, so a
  // provider that refuses by name is never reworded here.
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([resolveExecutable(executable, env), ...args], {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    })
  } catch (error) {
    throw new ProgressServeProviderMissing(executable, error)
  }
  const output = options.output ?? process.stdout
  // The request pipe is the third element of the stdio array this module asked for; Bun's own type is the union of
  // every allowed descriptor, so the one handle this loop writes frames to is named once, here.
  const maybePipe = child.stdin as unknown as
    | Readonly<{ write(text: string): unknown; flush(): Promise<number>; end(): unknown }>
    | undefined
  if (maybePipe === undefined || typeof maybePipe === "number") {
    throw new ProgressServeRefusal("page-serve-no-request-pipe", "the provider was started without a request pipe")
  }
  const requestPipe = maybePipe

  // A hand-rolled line splitter, not node:readline: under bun a readline interface created before an await drops lines
  // that arrived and ended inside it (measured 2026-11-25: a probe that pipes one frame and closes lost the frame and
  // hung). The client's stdin is exactly that shape at the end of a run.
  const providerLines = readLines(Readable.fromWeb(child.stdout as never))
  const client = readLines(options.input ?? (process.stdin as unknown as AsyncIterable<Uint8Array>))

  let held: IssuesActivityState = EMPTY_ACTIVITY
  let appliedSeq = 0
  let headSeq = 0
  let generation: string | undefined
  let journalAsOf: number | undefined
  let internalSeq = 0
  let failureLogged = false

  const say = (text: string): void => options.log(text.endsWith("\n") ? text : `${text}\n`)
  /**
   * One provider conversation at a time: a request's line and the answer's line are one step, so a journal batch
   * started for a frame and a page relayed for the client never read each other's answers. It is held per round trip,
   * not for a whole rebuild, so a page read waits at most one batch.
   */
  let providerBusy: Promise<unknown> = Promise.resolve()
  function withProvider<T>(work: () => Promise<T>): Promise<T> {
    const run = providerBusy.then(work, work)
    providerBusy = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Close the provider's request pipe and let it leave on its own: a clean end is not a killed reader. */
  async function endProvider(graceMs: number): Promise<number> {
    try {
      requestPipe.end()
    } catch {
      // silent-fallback-allow: a pipe the provider already closed is the ordinary race with its own exit, and the exit
      // status below is what the caller reads; the write failing changed nothing about it.
    }
    const graceful = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ])
    if (!graceful) child.kill("SIGTERM")
    return await child.exited
  }

  async function send(text: string): Promise<void> {
    requestPipe.write(text)
    await requestPipe.flush()
  }

  async function answerLine(what: string): Promise<string> {
    const next = await providerLines.next()
    if (next.done === true) {
      throw new ProgressServeRefusal(
        "page-serve-reader-exited",
        `the provider closed before answering ${what}`,
      )
    }
    return next.value
  }

  async function journalRead(after: number, sinceTs: number | undefined): Promise<JournalAnswer> {
    const seq = `yrd-journal-${String(++internalSeq)}`
    const line = await withProvider(async () => {
      await send(
        `${JSON.stringify({
          seq,
          request: { journal: { after, limit: JOURNAL_LIMIT, ...(sinceTs === undefined ? {} : { sinceTs }) } },
        })}\n`,
      )
      return await answerLine(`journal request ${seq}`)
    })
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      throw new ProgressServeRefusal(
        "page-serve-frame-unparsable",
        `the provider answered journal request ${seq} with a line that is not JSON: ${line.slice(0, 120)}`,
      )
    }
    const answer = frame as { seq?: unknown; refusal?: unknown; journal?: unknown }
    if (answer.seq !== seq) {
      throw new ProgressServeRefusal(
        "page-serve-frame-out-of-order",
        `the provider answered ${JSON.stringify(answer.seq)} while ${seq} was asked`,
      )
    }
    const refusal = answer.refusal
    if (refusal !== undefined && refusal !== null) {
      const named = isRecord(refusal) ? refusal : {}
      throw new ProgressServeRefusal(
        typeof named.code === "string" ? named.code : "page-serve-journal-refused",
        `${typeof named.message === "string" ? named.message : "the provider refused the journal request"}${
          typeof named.hint === "string" ? ` (${named.hint})` : ""
        }`,
      )
    }
    const journal = answer.journal
    if (
      !isRecord(journal) ||
      typeof journal.generation !== "string" ||
      typeof journal.head !== "number" ||
      !Number.isFinite(journal.head) ||
      typeof journal.asOf !== "number" ||
      !Array.isArray(journal.lines) ||
      typeof journal.more !== "boolean"
    ) {
      throw new ProgressServeRefusal(
        "page-serve-journal-malformed",
        `the provider answered ${seq} outside the journal shape: ${JSON.stringify(journal)?.slice(0, 200) ?? "absent"}`,
      )
    }
    return {
      generation: journal.generation,
      head: journal.head,
      asOf: journal.asOf,
      lines: journal.lines,
      more: journal.more,
    }
  }

  function eventsOf(lines: readonly unknown[], where: string): readonly IssuesActivityEvent[] {
    const events: IssuesActivityEvent[] = []
    for (const [index, line] of lines.entries()) {
      const event = activityEventOf(line, `${where} line ${String(index + 1)}`)
      if (event !== undefined) events.push(event)
    }
    return events
  }

  function lastSeqOf(lines: readonly unknown[]): number | undefined {
    const last = lines.at(-1)
    return isRecord(last) && typeof last.seq === "number" && Number.isFinite(last.seq) ? last.seq : undefined
  }

  /** Read the whole window again from change number 0, once, and say why. */
  async function rebuild(reason: string): Promise<void> {
    const began = now()
    let after = 0
    let state = EMPTY_ACTIVITY
    let batches = 0
    let head = 0
    let asOf = began
    let nextGeneration = ""
    for (;;) {
      const page = await journalRead(after, after === 0 ? began - windowMs : undefined)
      nextGeneration = page.generation
      head = page.head
      asOf = page.asOf
      state = applyActivity(state, eventsOf(page.lines, `journal batch ${String(batches + 1)}`), now(), windowMs)
      batches++
      if (!page.more) break
      if (batches >= JOURNAL_BATCH_BOUND) {
        throw new ProgressServeRefusal(
          "page-serve-journal-unbounded",
          `the activity window did not fit in ${String(JOURNAL_BATCH_BOUND)} batches of ${String(JOURNAL_LIMIT)} lines`,
        )
      }
      const lastSeq = lastSeqOf(page.lines)
      if (lastSeq === undefined || lastSeq <= after) {
        throw new ProgressServeRefusal(
          "page-serve-journal-stalled",
          `the provider answered more after ${String(after)} without advancing past it`,
        )
      }
      after = lastSeq
    }
    held = state
    appliedSeq = head
    headSeq = head
    generation = nextGeneration
    journalAsOf = asOf
    say(
      `yrd issues list-page-serve: rebuilt the activity window in ${String(Math.round(now() - began))} ms from ${
        String(batches)
      } journal batch(es): ${reason}`,
    )
  }

  /** Apply only the lines after the change number already held, rebuilding instead when the file was replaced. */
  async function refresh(): Promise<void> {
    if (generation === undefined) {
      await rebuild("the reader started")
      return
    }
    const began = now()
    let after = appliedSeq
    let state = held
    let batches = 0
    for (;;) {
      const page = await journalRead(after, undefined)
      if (page.generation !== generation) {
        await rebuild(`the vault replaced its store (${generation} -> ${page.generation})`)
        return
      }
      if (page.head < appliedSeq) {
        await rebuild(`the journal shrank (head ${String(page.head)} is behind the applied ${String(appliedSeq)})`)
        return
      }
      state = applyActivity(state, eventsOf(page.lines, `journal batch ${String(batches + 1)}`), now(), windowMs)
      batches++
      headSeq = page.head
      journalAsOf = page.asOf
      if (!page.more) {
        appliedSeq = page.head
        break
      }
      const lastSeq = lastSeqOf(page.lines)
      if (lastSeq === undefined || lastSeq <= after) {
        throw new ProgressServeRefusal(
          "page-serve-journal-stalled",
          `the provider answered more after ${String(after)} without advancing past it`,
        )
      }
      after = lastSeq
    }
    held = state
    if (now() - began >= SLOW_ANSWER_MS) {
      say(
        `yrd issues list-page-serve: journal refresh ${String(Math.round(now() - began))} ms from ${
          String(batches)
        } batch(es), head ${String(headSeq)}`,
      )
    }
  }

  /** The frame for one answer: the holds read now, the activity the reader holds, and how current it is. */
  async function progressFrame(): Promise<ServedProgress> {
    // The start rebuild runs beside the relay: a page read that needs no frame must never wait for a 24 h window, and
    // an answer that does need one waits for the one rebuild already under way instead of starting a second.
    await startup
    const holds = await options.readHolds()
    const began = now()
    let source: "ok" | "unreadable" = "ok"
    let failure: unknown
    try {
      await refresh()
      failureLogged = false
    } catch (error) {
      source = "unreadable"
      failure = error
    }
    const built = progressFromActivity(holds, now(), { state: held, source, windowMs })
    if (!built.ok) throw new ProgressServeRefusal("page-serve-holds-unreadable", built.detail)
    if (failure !== undefined && !failureLogged) {
      failureLogged = true
      say(
        `yrd issues list-page-serve: the activity refresh failed, answering from the state of ${
          journalAsOf === undefined ? "never" : new Date(journalAsOf).toISOString()
        }: ${describe(failure)}`,
      )
    } else if (source === "ok" && now() - began >= SLOW_ANSWER_MS) {
      say(`yrd issues list-page-serve: progress answer ${String(Math.round(now() - began))} ms`)
    }
    return {
      ...built.progress,
      seq: appliedSeq,
      lagSeq: source === "ok" ? headSeq - appliedSeq : null,
      asOf: journalAsOf === undefined ? null : new Date(journalAsOf).toISOString(),
    }
  }

  function refusalFor(seq: unknown, error: unknown): string {
    const named = error instanceof ProgressServeRefusal ? error : undefined
    return `${JSON.stringify({
      seq,
      refusal: {
        code: named?.code ?? "page-serve-progress-failed",
        message: describe(error),
      },
    })}\n`
  }

  /** A provider answer ends its request when it is a refusal, a page that is not a traversal, or a complete page. */
  function terminal(answerLine: string, traverse: boolean): boolean {
    if (!traverse) return true
    let answer: unknown
    try {
      answer = JSON.parse(answerLine)
    } catch {
      // silent-fallback-allow: an unparsable provider line is relayed to the client unchanged, which names it as its
      // own defect; guessing "more pages follow" here would hang a request that is already broken.
      return true
    }
    const frame = answer as { refusal?: unknown; page?: unknown }
    if (frame.refusal !== undefined && frame.refusal !== null) return true
    return !isRecord(frame.page) || frame.page.complete === true
  }

  async function relay(line: string, traverse: boolean): Promise<string> {
    return await withProvider(async () => {
      await send(`${line}\n`)
      let answer: string
      for (;;) {
        answer = await answerLine("the page request")
        if (terminal(answer, traverse)) return answer
        output.write(`${answer}\n`)
      }
    })
  }

  async function answerClient(frame: ClientFrame, line: string): Promise<void> {
    const { request } = frame
    const progress = request.progress === true
    if (!progress) {
      // Byte-identical: a request that never named Yrd's flag is the provider's own, and re-serialising it would
      // rewrite whitespace and number spelling for every ordinary caller.
      const answer = await relay(line, request.traverse === true)
      output.write(`${answer}\n`)
      return
    }
    const rest: Record<string, unknown> = { ...request }
    delete rest.progress
    // Nothing but the frame was asked for: no native read, so its cost does not follow the store.
    if (Object.keys(rest).length === 0) {
      try {
        output.write(`${JSON.stringify({ seq: frame.seq, progress: await progressFrame() })}\n`)
      } catch (error) {
        output.write(refusalFor(frame.seq, error))
      }
      return
    }
    const traverse = rest.traverse === true
    const answer = await relay(JSON.stringify({ seq: frame.seq, request: rest }), traverse)
    let parsed: unknown
    try {
      parsed = JSON.parse(answer)
    } catch {
      output.write(`${answer}\n`)
      return
    }
    // A refused page stays refused: the frame belongs to a page that was read, and inventing one would hide the cause.
    if (!isRecord(parsed) || !isRecord(parsed.page)) {
      output.write(`${answer}\n`)
      return
    }
    let progressValue: ServedProgress
    try {
      progressValue = await progressFrame()
    } catch (error) {
      // A traversal already relayed its earlier pages, so a refusal here would break the client's answer mid-stream:
      // the page goes through and the cause is said once on stderr, exactly as a projection-less page already is.
      say(`yrd issues list-page-serve: no progress frame on this answer: ${describe(error)}`)
      output.write(`${answer}\n`)
      return
    }
    output.write(`${JSON.stringify({ ...parsed, page: { ...parsed.page, progress: progressValue } })}\n`)
  }

  const forward: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"]
  const handlers = forward.map((signal) => {
    const handler = (): void => void child.kill(signal)
    process.once(signal, handler)
    return [signal, handler] as const
  })

  let exitCode = 0
  let startup: Promise<void>
  try {
    // Once on start, so the first answer is incremental: a failure is not fatal (the next answer retries and says so),
    // because the provider may be a `km` that predates the journal kind and the page reads must keep working.
    startup = rebuild("the reader started").catch((error: unknown) => {
      say(`yrd issues list-page-serve: no activity window at start; the first progress answer retries: ${describe(error)}`)
    })
    for await (const line of client) {
      if (line.trim() === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new ProgressServeRefusal(
          "page-serve-frame-unparsable",
          `the client sent a line that is not JSON: ${line.slice(0, 120)}`,
        )
      }
      if (!isRecord(parsed) || !isRecord(parsed.request)) {
        throw new ProgressServeRefusal(
          "page-serve-frame-malformed",
          `the client's frame ${JSON.stringify(isRecord(parsed) ? parsed.seq : null)} carries no request object`,
        )
      }
      await answerClient({ seq: parsed.seq, request: parsed.request }, line)
    }
    const code = await endProvider(2_000)
    exitCode = code === 0 ? 0 : 1
  } catch (error) {
    process.stderr.write(
      `yrd issues list-page-serve: ${error instanceof ProgressServeRefusal ? `${error.code}: ` : ""}${describe(error)}\n`,
    )
    await endProvider(2_000)
    exitCode = 1
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
  const endingSignal = child.signalCode
  if (endingSignal !== null && exitCode === 0) {
    process.stderr.write(`yrd issues list-page-serve: the declared reader was killed by ${endingSignal}\n`)
    exitCode = 1
  }
  return { exitCode }
}
