/**
 * @fakes @yrd/cli
 * A stand-in issues provider for `yrd issues` tests. The first argument picks the behaviour; the rest are echoed.
 *   json   print {"argv": [...rest]} and exit 0
 *   text   print a line that is not JSON and exit 0
 *   exit3  write "fake provider refused" to stderr and exit 3
 *   sleep  sleep 30 s (the caller's timeout must kill it)
 *   stall  write one stderr line, then sleep 30 s silently (the no-progress lease must kill it)
 *   trace  record the requested key and whether queue output is complete; issue-3 fails
 */
import { appendFileSync, existsSync } from "node:fs"

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
} else if (mode === "text") {
  process.stdout.write("this is not json\n")
} else if (mode === "exit3") {
  process.stderr.write("fake provider refused\n")
  process.exit(3)
} else if (mode === "sleep") {
  await Bun.sleep(30_000)
} else if (mode === "stall") {
  process.stderr.write(`fake provider: started pid=${process.pid}\n`)
  await Bun.sleep(30_000)
} else {
  process.stderr.write(`fake provider: unknown mode ${String(mode)}\n`)
  process.exit(9)
}

export {}
