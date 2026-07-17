/**
 * @failure The graceful-drain notice wraps a multi-row prose paragraph to bare stderr instead of one structured loggily record, colliding with the resident runner's log stream.
 * @level l2
 * @consumer @yrd/cli resident follow-runner operators
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event } from "loggily"
import { reportGracefulShutdown } from "../src/host.ts"

describe("graceful-drain notice", () => {
  it("emits ONE loggily warn with force-stop + recovery as fields, and never a bare stderr paragraph", () => {
    const events: Event[] = []
    const stderr: string[] = []
    const root = createLogger("yrd", [
      {
        level: "trace",
        // A stderr sink modelling the resident's log stream: reportGracefulShutdown
        // must NOT write a bare paragraph to it — only the structured warn record.
        write: (text: string) => stderr.push(text),
        objectMode: false,
      },
      { write: (event: Event) => events.push(event) },
    ])
    const log = root.child("runner")

    reportGracefulShutdown(log, "SIGINT")

    // No bare wrapped paragraph — the resident's stdout/stderr IS a log stream;
    // exactly one formatted warn record reaches it.
    expect(stderr.join("").split("\n").filter(Boolean)).toHaveLength(1)
    expect(stderr.join("")).toContain("WARN yrd:runner")

    const drain = events.filter(
      (event): event is Extract<Event, { kind: "log" }> => event.kind === "log" && event.level === "warn",
    )
    expect(drain).toHaveLength(1)
    // The force-stop hint and recovery guidance become structured FIELDS, not
    // prose wrap; the single warn message reads as one scannable notice.
    expect(drain[0]).toMatchObject({
      namespace: "yrd:runner",
      props: expect.objectContaining({
        signal: "SIGINT",
        mode: "drain",
        forceStop: expect.stringContaining("Ctrl-C"),
        recovery: "yrd queue recover",
      }),
    })
    expect(String(drain[0]?.message)).not.toContain("\n")
    log.end()
  })
})
