/**
 * @fakes @yrd/cli
 * A stand-in issues provider for `yrd issues` tests. The first argument picks the behaviour; the rest are echoed.
 *   json   print {"argv": [...rest]} and exit 0
 *   text   print a line that is not JSON and exit 0
 *   exit3  write "fake provider refused" to stderr and exit 3
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
