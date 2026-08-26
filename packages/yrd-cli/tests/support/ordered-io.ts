/**
 * A shared sequence-stamped output sink for process-level CLI tests.
 *
 * host.test.ts historically accumulated stdout and stderr into two INDEPENDENT
 * strings, so the ORDER in which the CLI interleaved the two streams was
 * unrepresentable — which is exactly why "the failure line must be the last
 * thing written" had no test. This sink records both streams into one ordered
 * event list while keeping the same per-stream string accessors, so existing
 * assertions keep working unchanged wherever it is adopted.
 */
export type OrderedOutputEvent = Readonly<{
  seq: number
  stream: "stdout" | "stderr"
  text: string
}>

export function orderedOutputIO() {
  const events: OrderedOutputEvent[] = []
  let seq = 0
  const record = (stream: OrderedOutputEvent["stream"]) => (text: string) => {
    events.push({ seq: (seq += 1), stream, text })
  }
  const joined = (stream: OrderedOutputEvent["stream"]) =>
    events
      .filter((event) => event.stream === stream)
      .map((event) => event.text)
      .join("")
  return {
    io: { stdout: record("stdout"), stderr: record("stderr") },
    events: events as readonly OrderedOutputEvent[],
    stdout: () => joined("stdout"),
    stderr: () => joined("stderr"),
    /** The final write across BOTH streams — the one the terminal shows last. */
    last: (): OrderedOutputEvent | undefined => events.at(-1),
  }
}
