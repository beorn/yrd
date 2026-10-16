/**
 * A stand-in issues provider for `yrd issues` tests. The first argument picks the behaviour; the rest are echoed.
 *   json   print {"argv": [...rest]} and exit 0
 *   text   print a line that is not JSON and exit 0
 *   exit3  write "fake provider refused" to stderr and exit 3
 *   sleep  sleep 30 s (the caller's timeout must kill it)
 */
const [mode, ...rest] = process.argv.slice(2)
if (mode === "json") {
  process.stderr.write("fake provider: applied\n")
  process.stdout.write(`${JSON.stringify({ argv: rest })}\n`)
} else if (mode === "text") {
  process.stdout.write("this is not json\n")
} else if (mode === "exit3") {
  process.stderr.write("fake provider refused\n")
  process.exit(3)
} else if (mode === "sleep") {
  await Bun.sleep(30_000)
} else {
  process.stderr.write(`fake provider: unknown mode ${String(mode)}\n`)
  process.exit(9)
}
