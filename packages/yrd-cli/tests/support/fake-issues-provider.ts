/**
 * @fakes @yrd/cli
 * A stand-in issues provider for `yrd issues` tests. The first argument picks the behaviour; the rest are echoed.
 *   json   print {"argv": [...rest]} and exit 0
 *   text   print a line that is not JSON and exit 0
 *   exit3  write "fake provider refused" to stderr and exit 3
 *   rail-telemetry <refusal>  write km's lookup counters, then the refusal, and exit 1
 *   rail-telemetry-envelope <reason>  write km's counters, then a JSON envelope whose skipped[].reason is the
 *                                 refusal at a position past 300 characters, and exit 1
 *   rail-refusal-envelope <reason>  write km's counters, then km's own refused envelope whose refusal.reason sits
 *                                 past 300 characters (the operation id is echoed first), and exit 1
 *   rail-refusal-envelope-stderr <reason>  the same envelope, written to stderr after the counters, and exit 1
 *   close-id-moved[-behind-telemetry]  refuse the first close id, answer the ref-safe settled retry with no-change
 *   close-id-moved-settled-refused  refuse both, so the attempt can prove it reports the retry's own failure
 *   raised <message>  write a code frame, then `TypeError: <message>`, and exit 1 (a provider that threw)
 *   sleep  sleep 30 s (the caller's timeout must kill it)
 *   stall  write one stderr line, then sleep 30 s silently (the no-progress lease must kill it)
 *   trace  record the requested key and whether queue output is complete; issue-3 fails
 *   pages  <calls-log> <pages-json> <request>: append the request, answer the page whose token it names
 *   stream <calls-log> <pages-json> <request>: append the request; print every page as one compact JSON line when
 *          it says `traverse:true`, otherwise only the first page (what a provider without traversal support does)
 *   count  <calls-log> <stdout bytes>: append one line per call, answer the bytes (one activity read per refresh)
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs"

const [mode, ...rest] = process.argv.slice(2)
if (mode === "json") {
  process.stderr.write("fake provider: applied\n")
  process.stdout.write(`${JSON.stringify({ argv: rest })}\n`)
} else if (mode === "resolve") {
  process.stdout.write(`${JSON.stringify({ keys: rest })}\n`)
} else if (mode === "reply") {
  if (rest[0] === undefined) throw new Error("reply requires stdout bytes")
  process.stdout.write(rest[0])
} else if (mode === "trace") {
  const [key, outputMarker, starts] = rest
  if (key === undefined || outputMarker === undefined || starts === undefined) {
    throw new Error("trace requires key, output marker and starts file")
  }
  const observed = { key, queueOutputEmitted: existsSync(outputMarker) }
  appendFileSync(starts, `${JSON.stringify(observed)}\n`)
  if (key === "issue-3") {
    process.stderr.write("fake provider refused issue-3\n")
    process.exit(3)
  }
  process.stdout.write(`${JSON.stringify(observed)}\n`)
} else if (mode === "pages") {
  const [callsLog, pagesFile, requestJson] = rest
  if (callsLog === undefined || pagesFile === undefined || requestJson === undefined) {
    throw new Error("pages requires a calls log, a pages file and the page request")
  }
  const request = JSON.parse(requestJson) as { page?: unknown }
  appendFileSync(callsLog, `${JSON.stringify({ token: request.page ?? null })}\n`)
  const pages = JSON.parse(readFileSync(pagesFile, "utf8")) as { token: string | null; page: unknown }[]
  const token = typeof request.page === "string" ? request.page : null
  const page = pages.find((candidate) => candidate.token === token)
  if (page === undefined) {
    process.stderr.write(`fake provider: no page for token ${String(token)}\n`)
    process.exit(9)
  }
  process.stdout.write(`${JSON.stringify(page.page)}\n`)
} else if (
  mode === "close-id-moved" ||
  mode === "close-id-moved-behind-telemetry" ||
  mode === "close-id-moved-settled-refused"
) {
  const [key, reason, id, callsLog] = rest
  if (key === undefined || reason === undefined || id === undefined || callsLog === undefined) {
    throw new Error("close-id-moved requires key, reason, id and a calls log")
  }
  appendFileSync(callsLog, `${key}\t${reason}\t${id}\n`)
  // km names its pending-publication ref after the operation id, so an id must satisfy `[A-Za-z0-9][A-Za-z0-9._-]*`
  // and never contain `..` or end in `.lock` (km-storage pending-publication.ts). A retry id outside that grammar is
  // refused before any write, which is how a `:settled` retry could never land while its failure went unreported
  // (38844 via #38952). Enforced here so such an id fails the test instead of the queue.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) || id.includes("..") || id.endsWith(".lock")) {
    process.stdout.write(
      `${JSON.stringify({
        status: "unknown",
        refusal: {
          kind: "landing-unknown",
          reason: `pending publication: operation id ${JSON.stringify(id)} cannot name a ref`,
          retryable: false,
        },
      })}\n`,
    )
    process.exit(1)
  }
  if (mode === "close-id-moved-settled-refused" && id.endsWith("-settled")) {
    process.stdout.write(
      `${JSON.stringify({
        status: "refused",
        refusal: { kind: "landing-failed", reason: "settled retry refused by the fake provider", retryable: false },
      })}\n`,
    )
    process.exit(1)
  }
  if (id.endsWith("-settled")) {
    process.stdout.write(`${JSON.stringify({ noChange: true })}\n`)
  } else {
    // km's rail writes its counters before the refusal it explains (#38952).
    if (mode === "close-id-moved-behind-telemetry") {
      process.stderr.write("lookup-substeps start=1 end=2 route=certified outcome=ledger-hit\n")
    }
    process.stderr.write(
      `issues close: State operation id ${JSON.stringify(id)} already belongs to another request (different fingerprint: recorded close-with-evidence:aaaa, requested close-with-evidence:bbbb)\n`,
    )
    process.exit(3)
  }
} else if (mode === "count") {
  const [callsLog, bytes] = rest
  if (callsLog === undefined || bytes === undefined) throw new Error("count requires a calls log and bytes")
  appendFileSync(callsLog, "call\n")
  process.stdout.write(bytes)
} else if (mode === "stream") {
  const [callsLog, pagesFile, requestJson] = rest
  if (callsLog === undefined || pagesFile === undefined) throw new Error("stream requires a calls log and a pages file")
  const request = requestJson === undefined ? {} : (JSON.parse(requestJson) as { traverse?: unknown })
  appendFileSync(callsLog, `${JSON.stringify({ traverse: request.traverse === true, request: requestJson ?? "" })}\n`)
  const pages = JSON.parse(readFileSync(pagesFile, "utf8")) as unknown[]
  const answer = request.traverse === true ? pages : pages.slice(0, 1)
  process.stdout.write(`${answer.map((page) => JSON.stringify(page)).join("\n")}\n`)
} else if (mode === "text") {
  process.stdout.write("this is not json\n")
} else if (mode === "exit3") {
  process.stderr.write("fake provider refused\n")
  process.exit(3)
} else if (mode === "rail-telemetry") {
  const [refusal] = rest
  if (refusal === undefined) throw new Error("rail-telemetry requires a refusal")
  process.stderr.write("lookup-substeps start=1 end=2 route=certified outcome=ledger-hit\n")
  process.stderr.write(`${refusal}\n`)
  process.exit(1)
} else if (mode === "rail-telemetry-envelope") {
  // The refusal sits past 300 characters of envelope, where a one-line text cut would hide it (#38952).
  const [reason] = rest
  if (reason === undefined) throw new Error("rail-telemetry-envelope requires a reason")
  process.stderr.write("lookup-substeps start=1 end=2 route=certified outcome=ledger-hit\n")
  process.stdout.write(
    `${JSON.stringify({
      applied: [],
      skipped: [
        {
          ref: "@km/work/a",
          changedPaths: Array.from(
            { length: 12 },
            (_, index) => `/hh/var/wt/${index}-a-long-worktree-path-${"x".repeat(40)}`,
          ),
          reason,
        },
      ],
    })}\n`,
  )
  process.exit(1)
} else if (mode === "rail-refusal-envelope") {
  // km's own refusal envelope: the reason follows the operation id it echoes, past a 300-character text cut (#38952).
  const [reason] = rest
  if (reason === undefined) throw new Error("rail-refusal-envelope requires a reason")
  process.stderr.write("lookup-substeps start=1 end=2 route=certified outcome=ledger-hit\n")
  process.stdout.write(
    `${JSON.stringify({
      kmOutcome: 1,
      verb: "bd close",
      ref: "01M8CN5GQF7FDHJKCC45RDVRR7",
      operationId: `yrd1-0${"a".repeat(58)}`,
      status: "refused",
      refusal: { kind: "landing-failed", reason },
    })}\n`,
  )
  process.exit(1)
} else if (mode === "rail-refusal-envelope-stderr") {
  // km also writes its envelope to stderr, after the counters (#38952): the text line that follows must not hide it.
  const [reason] = rest
  if (reason === undefined) throw new Error("rail-refusal-envelope-stderr requires a reason")
  process.stderr.write("lookup-substeps start=1 end=2 route=certified outcome=ledger-hit\n")
  process.stderr.write(
    `${JSON.stringify({
      kmOutcome: 1,
      verb: "bd close",
      ref: "01M8CN5GQF7FDHJKCC45RDVRR7",
      operationId: `yrd1-0${"a".repeat(58)}`,
      status: "refused",
      refusal: { kind: "landing-failed", reason },
    })}\n`,
  )
  process.exit(1)
} else if (mode === "raised") {
  const [message] = rest
  if (message === undefined) throw new Error("raised requires a message")
  process.stderr.write(`427 |     const oldest = row?.oldest ?? null\n      ^\nTypeError: ${message}\n`)
  process.exit(1)
} else if (mode === "sleep") {
  await Bun.sleep(30_000)
} else if (mode === "stall") {
  process.stderr.write(`fake provider: started pid=${process.pid}\n`)
  await Bun.sleep(30_000)
} else {
  process.stderr.write(`fake provider: unknown mode ${String(mode)}\n`)
  process.exit(9)
}
