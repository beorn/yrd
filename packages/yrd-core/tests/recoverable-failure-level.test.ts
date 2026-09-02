/**
 * @failure A thrown failure the runner survives by design — a busy journal, a
 *          peer holding the queue, a Job a concurrent writer settled first —
 *          was logged at ERROR by the lifecycle it escaped through, because
 *          the lifecycle only sees a thrown error and not the catch three
 *          frames up that skips the cycle. With an ERROR row now fatal to the
 *          pass, that row would stop the runner on a condition it was about
 *          to retry.
 * @level l1
 * @consumer @yrd/core observeYrdLifecycle · every lifecycle that reports a throw
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createFailure, isRecoverableFailure, markRecoverable, observeYrdLifecycle } from "../src/index.ts"

function capture() {
  const events: LogEvent[] = []
  const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
  const failed = () =>
    events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> => event.kind === "log" && event.props?.outcome === "failed",
    )
  return { log, failed }
}

describe("a thrown failure that declares itself recoverable", () => {
  it("is reported at WARN by the lifecycle it escapes through", async () => {
    const { log, failed } = capture()
    const busy = markRecoverable(createFailure({ kind: "infrastructure", code: "journal-busy", message: "yrd: busy" }))
    await expect(
      observeYrdLifecycle(log, { lifecycle: "append" }, () => {
        throw busy
      }),
    ).rejects.toBe(busy)
    expect(failed()).toMatchObject({ level: "warn", namespace: "yrd:append" })
    expect(isRecoverableFailure(busy)).toBe(true)
  })

  it("covers a bare Error too — the typed conflict classes carry no FailureFact", async () => {
    const { log, failed } = capture()
    const conflict = markRecoverable(new Error("yrd: queue 'main' is running 'R1'"))
    await expect(
      observeYrdLifecycle(log, { lifecycle: "compose" }, () => {
        throw conflict
      }),
    ).rejects.toBe(conflict)
    expect(failed()).toMatchObject({ level: "warn" })
  })

  it("leaves an unmarked infrastructure failure, and an unmarked bare Error, at ERROR (negative control)", async () => {
    for (const thrown of [
      createFailure({ kind: "infrastructure", code: "journal-corrupt", message: "yrd: corrupt" }),
      new Error("yrd: mint collision"),
    ]) {
      const { log, failed } = capture()
      await expect(
        observeYrdLifecycle(log, { lifecycle: "append" }, () => {
          throw thrown
        }),
      ).rejects.toBe(thrown)
      expect(failed()).toMatchObject({ level: "error" })
      expect(isRecoverableFailure(thrown)).toBe(false)
    }
  })

  it("does not touch the error's own identity or message", () => {
    const failure = createFailure({
      kind: "infrastructure",
      code: "exclusive-busy",
      message: "yrd: writer lock is busy",
    })
    expect(markRecoverable(failure)).toBe(failure)
    expect(failure.name).toBe("YrdFailure")
    expect(failure.message).toBe("yrd: writer lock is busy")
    expect(Object.keys(failure)).not.toContain("recoverable")
  })
})
